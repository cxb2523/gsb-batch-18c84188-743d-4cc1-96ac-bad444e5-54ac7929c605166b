import Store, { Shape } from '@/store/Store';
import { Tools } from '@/enums/Tools';
import PenModel from '@/models/pen.model';
import LineModel from '@/models/line.model';
import EllipseModel from '@/models/ellipse.model';
import ArrowModel from '@/models/arrow.model';
import PolygonModel from '@/models/polygon.model';
import TextModel from '@/models/text.model';
import ImageModel from '@/models/image.model';
import { deepCopy } from '@/utils/Utils';
import { Theme } from '@/enums/Theme';
import ThemeService from '@/services/theme.service';

export enum UndoRedoEventType {
  CREATE = 'CREATE',
  DELETE = 'DELETE',
  MOVE = 'MOVE',
  RESIZE = 'RESIZE',
  UPDATE = 'UPDATE',
}

type UndoRedoEvent = {
  type: UndoRedoEventType;
  index: number;
  shape: {
    from: Shape | null;
    to: Shape | null;
  };
  //the live shape the event applies to. Restoring onto it keeps object identity, which
  //texts need because the canvas shape, the html input and every undo entry share it
  target?: Shape | null;
  //selection to restore when the event is undone (undo) or redone (redo). Copy/delete use
  //it so the original shape keeps its selected state
  selection?: {
    undo: Shape | null;
    redo: Shape | null;
  };
  //position the event had in the undo stack, so redo restores the same order
  position?: number;
};

class UndoRedoService {
  private static undoStack: UndoRedoEvent[] = [];
  private static redoStack: UndoRedoEvent[] = [];

  //the drawing tools keep a zero-size placeholder event that they replace while the user
  //drags. Tracking it lets push tell idle churn apart from a finished drawing, so the redo
  //history is only invalidated when something is really drawn
  private static pendingEvent: UndoRedoEvent | null = null;

  private static isText(shape: Shape | null | undefined): shape is TextModel {
    return shape instanceof TextModel;
  }

  public static push(undoRedoEvent: UndoRedoEvent, index?: number) {
    this.dropStalePlaceholderTracking();

    const previous = this.undoStack[this.undoStack.length - 1];
    const previousTracked = this.pendingEvent !== null && previous === this.pendingEvent;
    //the tracked placeholder was mutated into a real shape while the user was dragging
    const previousCompleted = previousTracked && !this.isPendingDrawingEvent(previous);
    //whether this push is a real action at all. A zero-size placeholder is not, unless it is
    //the one that closes a drawing which just grew past the placeholder state
    const isRealAction = !this.isPendingDrawingEvent(undoRedoEvent) || previousCompleted;

    if (isRealAction) {
      //a real new action invalidates everything that could be redone
      this.redoStack = [];
    }

    this.pendingEvent = this.isPendingDrawingEvent(undoRedoEvent) ? undoRedoEvent : null;

    if (index !== undefined) {
      //insert at an explicit position: used when a text shape is placed into the middle
      this.undoStack.splice(this.clampIndex(index, this.undoStack.length), 0, undoRedoEvent);
    } else {
      this.undoStack.push(undoRedoEvent);
    }
  }

  public static pop() {
    const event = this.undoStack.pop();
    if (event === this.pendingEvent) this.pendingEvent = null;
    return event;
  }

  private static isTrackedPlaceholderOnTop() {
    //true while the tracked placeholder is still the newest event
    const top = this.undoStack[this.undoStack.length - 1];
    return this.pendingEvent !== null && top === this.pendingEvent;
  }

  public static removeAllTexts() {
    //drop every history entry that refers to a text; kept for callers that still detach the
    //texts from the store, now that text shapes normally survive their html conversion
    const isTextEvent = (event: UndoRedoEvent) =>
      this.isText(event.shape.from) || this.isText(event.shape.to);

    this.undoStack = this.undoStack.filter((event) => !isTextEvent(event));
    this.redoStack = this.redoStack.filter((event) => !isTextEvent(event));
    this.pendingEvent = null;
  }

  private static dropStalePlaceholderTracking() {
    //the tracked placeholder may have been removed (for example by an undo); forget it then
    if (this.pendingEvent && !this.undoStack.includes(this.pendingEvent)) {
      this.pendingEvent = null;
    }
  }

  private static isPendingDrawingEvent(event: UndoRedoEvent | undefined) {
    //true for the provisional, not-yet-drawn shape the drawing tools keep on the stack
    if (!event || event.type !== UndoRedoEventType.CREATE) return false;

    const shape = event.shape.to;
    if (!shape) return false;

    switch (shape.constructor) {
      case PenModel:
        return (shape as PenModel).path.length <= 1;
      case LineModel:
      case EllipseModel:
      case ArrowModel:
      case PolygonModel: {
        const base = shape as { x1: number; y1: number; x2: number; y2: number };
        return base.x1 === base.x2 && base.y1 === base.y2;
      }
      default:
        return false;
    }
  }

  private static clampIndex(index: number, length: number) {
    if (index < 0) return 0;
    if (index > length) return length;
    return index;
  }

  private static locateShape(shape: Shape | null | undefined) {
    //find the live object that stands for a recorded state
    if (!shape) return null;
    if (Store.allShapes.includes(shape)) return shape;
    if (this.isText(shape)) {
      const text = Store.getTextById(shape.id);
      if (text) return text;
    }
    return null;
  }

  private static restoreInto(target: Shape, state: Shape | null | undefined) {
    //copy the recorded state onto the live object so its identity is preserved
    if (!state) return;

    const targetRecord = target as unknown as Record<string, unknown>;
    const stateRecord = state as unknown as Record<string, unknown>;

    for (const key of Object.keys(stateRecord)) {
      //the text identity is the anchor every undo entry points at, never overwrite it
      if (key === 'id' && this.isText(target)) continue;
      //images hold a decoded bitmap, cloning it would force a reload
      if (key === 'image' && stateRecord[key] instanceof HTMLImageElement) continue;
      targetRecord[key] = deepCopy(stateRecord[key]);
    }

    if (this.isText(target)) {
      //placement is owned by the store, the html input is rebuilt on demand
      target.isEditing = false;
    }
  }

  private static insertShape(shape: Shape | null | undefined, index: number) {
    if (!shape) return;
    //never insert the same shape twice
    if (Store.allShapes.includes(shape)) return;
    if (this.isText(shape) && Store.getTextById(shape.id)) return;

    const position = this.clampIndex(index, Store.allShapes.length);
    Store.allShapes.splice(position, 0, shape);
    this.syncTextPlacement();
  }

  private static removeShape(shape: Shape | null | undefined) {
    //remove exactly the shape that was recorded, never whatever happens to sit at an index
    const live = this.locateShape(shape);
    if (!live) return;

    const index = Store.allShapes.indexOf(live);
    if (index < 0) return;
    Store.allShapes.splice(index, 1);
    this.syncTextPlacement();
  }

  private static applyState(event: UndoRedoEvent, state: Shape | null | undefined) {
    if (!state) return;

    const live = this.locateShape(event.target) ?? this.locateShape(state);
    if (live) {
      this.restoreInto(live, state);
      this.syncTextPlacement();
      return;
    }

    //nothing to restore onto (for example a decoupled update record), fall back to putting
    //the recorded state back at the position the event was recorded with
    const index = this.clampIndex(event.index, Store.allShapes.length);
    if (index < Store.allShapes.length) {
      Store.allShapes.splice(index, 1, state);
    } else {
      Store.allShapes.push(state);
    }
    this.syncTextPlacement();
  }

  private static syncTextPlacement() {
    Store.allShapes.forEach((shape, index) => {
      if (this.isText(shape)) {
        shape.stackIndex = index;
      }
    });
  }

  private static applySelection(shape: Shape | null | undefined) {
    if (!shape) return;
    const live = this.locateShape(shape);
    if (!live) return;

    Store.allShapes.forEach((item) => item.setIsSelected(false));
    live.setIsSelected(true);
  }

  public static undo(_selectedTool: Tools) {
    this.dropStalePlaceholderTracking();
    if (this.isTrackedPlaceholderOnTop() && !this.isPendingDrawingEvent(this.pendingEvent!)) {
      //the drawing finished but the "completed" push did not happen yet: the finished shape
      //is a real action, so nothing could be redone after undoing it
      this.redoStack = [];
    }
    this.pendingEvent = null;

    //skip provisional shapes: they are not real steps, consuming them would make the first
    //Ctrl+Z after a quick tool switch undo nothing visible
    let popIndex = this.undoStack.length - 1;
    while (popIndex >= 0 && this.isPendingDrawingEvent(this.undoStack[popIndex])) {
      popIndex--;
    }

    if (popIndex < 0) return;

    const event = this.undoStack[popIndex];
    if (!event) return;

    this.undoStack.splice(popIndex, 1);

    //remove selection from the shapes involved before undoing
    event.shape.from?.setIsSelected(false);
    event.shape.to?.setIsSelected(false);

    event.position = popIndex;
    this.redoStack.push(event);

    switch (event.type) {
      case UndoRedoEventType.CREATE:
        //remove the created shape
        this.removeShape(event.target ?? event.shape.to);
        break;
      case UndoRedoEventType.DELETE:
        if (event.shape.to) {
          //a delete record that also carries a "to" state is a property update
          this.applyState(event, event.shape.from);
        } else {
          //add the deleted shape back
          this.insertShape(event.shape.from, event.index);
        }
        break;
      case UndoRedoEventType.MOVE:
      case UndoRedoEventType.RESIZE:
      case UndoRedoEventType.UPDATE:
        //restore the previous state of the shape in place
        this.applyState(event, event.shape.from);
        break;
    }

    this.applySelection(event.selection?.undo);
  }

  public static redo(_selectedTool: Tools) {
    const event = this.redoStack.pop();
    if (!event) return;

    const position = this.clampIndex(
      event.position !== undefined ? event.position : this.undoStack.length,
      this.undoStack.length
    );
    this.undoStack.splice(position, 0, event);
    delete event.position;

    switch (event.type) {
      case UndoRedoEventType.CREATE:
        //add the shape back
        this.insertShape(event.target ?? event.shape.to, event.index);
        break;
      case UndoRedoEventType.DELETE:
        if (event.shape.to) {
          //property update, apply the new state again
          this.applyState(event, event.shape.to);
        } else {
          //remove the deleted shape again
          this.removeShape(event.shape.from);
        }
        break;
      case UndoRedoEventType.MOVE:
      case UndoRedoEventType.RESIZE:
      case UndoRedoEventType.UPDATE:
        //apply the new state of the shape in place
        this.applyState(event, event.shape.to);
        break;
    }

    this.applySelection(event.selection?.redo);
  }

  static filterEmptyShapes(selectedTool: Tools) {
    //filter all empty shapes except that is selected
    const filterStack = (stack: UndoRedoEvent[]) => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const event = stack[i];
        if (!event) continue;

        let shape;
        if (event.type === UndoRedoEventType.CREATE) {
          shape = event.shape.to;
        } else if (event.type === UndoRedoEventType.DELETE) {
          shape = event.shape.from;
        } else {
          shape = event.shape.to;
        }
        if (!shape) continue;

        const filter = Store.getFilter(shape);
        let condition: boolean;

        switch (shape.constructor) {
          case PenModel:
            condition = selectedTool === Tools.Pen || filter;
            break;
          case LineModel:
            condition = selectedTool === Tools.Line || filter;
            break;
          case EllipseModel:
            condition = selectedTool === Tools.Ellipse || filter;
            break;
          case ArrowModel:
            condition = selectedTool === Tools.Arrow || filter;
            break;
          case PolygonModel:
            condition = selectedTool === Tools.Polygon || filter;
            break;
          case TextModel:
            condition = selectedTool === Tools.Text || filter;
            break;
          case ImageModel:
            condition = selectedTool === Tools.Image || filter;
            break;
          default:
            condition = false;
        }

        if (!condition) {
          stack.splice(i, 1);
        }
      }
    };

    filterStack(this.undoStack);
    //an undone action must not be replayed later if the shape it refers to became empty
    filterStack(this.redoStack);
  }

  static changeTheme(theme: Theme) {
    function eventCallback() {
      return (event: UndoRedoEvent) => {
        const shapeFrom = event.shape.from;
        if (shapeFrom) {
          ThemeService.changeShapesTheme(shapeFrom, theme);
        }

        const shapeTo = event.shape.to;
        if (shapeTo) {
          ThemeService.changeShapesTheme(shapeTo, theme);
        }
      };
    }

    //change all shapes themes in undo stack
    this.undoStack.forEach(eventCallback());

    //change all shapes themes in redo stack
    this.redoStack.forEach(eventCallback());
  }
}

export default UndoRedoService;

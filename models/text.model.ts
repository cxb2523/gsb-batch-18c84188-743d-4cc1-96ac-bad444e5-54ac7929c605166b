import React from 'react';
import { Mouse } from '@/app/page';
import { StrokeColor } from '@/enums/Colors';
import { Fonts } from '@/enums/Fonts';
import SelectionService from '@/services/selection.service';
import Store from '@/store/Store';
import ResizeService from '@/services/resize.service';
import UndoRedoService, { UndoRedoEventType } from '@/services/undo.redo.service';
import { Theme } from '@/enums/Theme';

class TextModel {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontColor: StrokeColor;
  fontFamily: string;
  stackIndex: number;
  isSelected: boolean = false;
  //stable identity shared between the canvas shape and its html input
  id: string;
  //true while the text is being edited through the html input element
  isEditing: boolean = false;

  private static nextId = 0;

  static generateId() {
    TextModel.nextId++;
    return `text-${TextModel.nextId}`;
  }

  setIsSelected(isSelected: boolean) {
    this.isSelected = isSelected;
  }

  constructor(
    x: number,
    y: number,
    text: string,
    fontSize: number,
    fontColor: StrokeColor,
    fontFamily: string,
    stackIndex: number,
    id?: string
  ) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.fontSize = fontSize;
    this.fontColor = fontColor;
    this.fontFamily = fontFamily;
    this.stackIndex = stackIndex;
    this.id = id ?? TextModel.generateId();
  }

  static TEXT_DIV_TAG = 'text-input';

  static drawCurrentText(
    mouseRef: React.MutableRefObject<Mouse>,
    parentRef: React.MutableRefObject<HTMLElement | null>,
    selectedFontSize: number,
    selectedFontColor: StrokeColor,
    selectedFontFamily: string,
    stackIndex: number
  ) {
    if (mouseRef.current.down) {
      //get input elements count for stack index
      const inputElements = TextModel.getInputElements(parentRef.current as HTMLElement);
      const inputElement = TextModel.createInput(
        mouseRef.current.x,
        mouseRef.current.y,
        selectedFontSize,
        selectedFontColor,
        selectedFontFamily,
        parentRef.current?.clientWidth as number,
        parentRef.current?.clientHeight as number,
        stackIndex + inputElements.length
      );

      parentRef.current?.appendChild(inputElement);
      inputElement.focus();

      mouseRef.current.down = false;
    }
  }

  static drawStoredText(ctx: CanvasRenderingContext2D, text: TextModel) {
    ctx.font = `${text.fontSize}px ${text.fontFamily}`;
    ctx.fillStyle = text.fontColor;

    let verticalOffset = 0;

    switch (text.fontFamily.replace(/['"]+/g, '')) {
      case Fonts.Arial:
        verticalOffset = text.fontSize * 0.41;
        break;
      case Fonts.Verdana:
        verticalOffset = text.fontSize * 0.36;
        break;
      case Fonts.Tahoma:
        verticalOffset = text.fontSize * 0.36;
        break;
      case Fonts.TrebuchetMS:
        verticalOffset = text.fontSize * 0.4;
        break;
      case Fonts.TimesNewRoman:
        verticalOffset = text.fontSize * 0.41;
        break;
      case Fonts.Georgia:
        verticalOffset = text.fontSize * 0.41;
        break;
      case Fonts.Garamond:
        verticalOffset = text.fontSize * 0.45;
        break;
      case Fonts.CourierNew:
        verticalOffset = text.fontSize * 0.48;
        break;
      case Fonts.BrushScriptMT:
        verticalOffset = text.fontSize * 0.48;
        break;
      case Fonts.ComicSansMS:
        verticalOffset = text.fontSize * 0.35;
        break;
    }

    const lines = text.text.split('\n');
    lines.forEach((line, index) => {
      ctx.fillText(line, text.x, text.y + text.fontSize * (index + 1) * 1.5 - verticalOffset);
    });

    if (text.isSelected) {
      SelectionService.drawTextSelectionBox(ctx, text, true);
    }
  }

  static isTextHovered(
    text: TextModel,
    mouseRef: React.MutableRefObject<Mouse>,
    ctx: CanvasRenderingContext2D
  ) {
    ctx.font = `${text.fontSize}px ${text.fontFamily}`;
    const { x, y } = mouseRef.current;
    const lines = text.text.split('\n');

    const minX = text.x;
    const minY = text.y + text.fontSize / 4;
    const maxX = text.x + Math.max(...lines.map((line) => ctx.measureText(line).width));
    const maxY = text.y + text.fontSize * 1.5 * lines.length - text.fontSize / 6;

    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  static getHoveredEdgeOrCorner(
    text: TextModel,
    mouseRef: React.MutableRefObject<Mouse>,
    ctx: CanvasRenderingContext2D
  ) {
    ctx.font = `${text.fontSize}px ${text.fontFamily}`;
    const lines = text.text.split('\n');

    // const minX = text.x;
    // const minY = text.y + text.fontSize / 4;
    // const maxX = text.x + Math.max(...lines.map((line) => ctx.measureText(line).width));
    // const maxY = text.y + text.fontSize * 1.5 * lines.length - text.fontSize / 6;

    const points = [
      { x: text.x, y: text.y + text.fontSize / 4 },
      {
        x: text.x + Math.max(...lines.map((line) => ctx.measureText(line).width)),
        y: text.y + text.fontSize * 1.5 * lines.length - text.fontSize / 6,
      },
    ];

    return ResizeService.detectRectangleResizeSelection(mouseRef, points);
  }

  static createInput(
    x: number,
    y: number,
    fontSize: number,
    fontColor: StrokeColor,
    fontFamily: string,
    screenWidth: number,
    screenHeight: number,
    stackIndex: number,
    id?: string
  ) {
    const inputElement = document.createElement('div');
    inputElement.className = TextModel.TEXT_DIV_TAG;
    inputElement.contentEditable = 'true';
    inputElement.style.position = 'absolute';
    inputElement.style.top = `${y}px`;
    inputElement.style.left = `${x}px`;
    inputElement.style.border = 'none';
    inputElement.style.outline = 'none';
    inputElement.style.resize = 'auto';
    inputElement.style.color = fontColor;
    inputElement.style.fontSize = `${fontSize}px`;
    inputElement.style.fontFamily = fontFamily;
    inputElement.style.backgroundColor = 'transparent';
    inputElement.dataset.stackIndex = stackIndex.toString();
    const textId = id ?? TextModel.generateId();
    inputElement.dataset.textId = textId;
    //an input created by the text tool has no canvas shape behind it yet, it must survive
    //the reconciliation pass until it is switched away from
    if (!id) inputElement.dataset.pending = 'true';

    inputElement.oninput = () => {
      //   move the input element to the left if it exceeds the screen width
      const inputWidth = inputElement.clientWidth;
      if (x + inputWidth > screenWidth) {
        inputElement.style.left = `${screenWidth - inputWidth}px`;
      }

      //   move the input element to the top if it exceeds the screen height
      const inputHeight = inputElement.clientHeight;
      if (y + inputHeight > screenHeight) {
        inputElement.style.top = `${screenHeight - inputHeight}px`;
      }
    };

    return inputElement;
  }

  static getInputElements(parentDiv: HTMLElement) {
    if (!parentDiv) return [];
    return Array.from(parentDiv.children).filter((child) => {
      return child.className === TextModel.TEXT_DIV_TAG;
    }) as HTMLDivElement[];
  }

  static readInputText(input: HTMLDivElement) {
    //contenteditable may leave a trailing newline or non breaking spaces behind
    return input.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '');
  }

  static convertToCanvas(parentDiv: HTMLElement) {
    //convert html input elements to canvas text shapes, one undo entry per text
    const inputElements = TextModel.getInputElements(parentDiv);

    inputElements.forEach((inputElement) => {
      const input = inputElement as HTMLDivElement;
      const textValue = TextModel.readInputText(input);
      const id = input.dataset.textId;
      const x = parseInt(input.style.left) || 0;
      const y = parseInt(input.style.top) || 0;
      const fontSize = parseInt(input.style.fontSize) || 30;

      parentDiv.removeChild(inputElement);

      const existingText = id ? Store.getTextById(id) : null;

      if (textValue.trim().length === 0) {
        //an empty input never becomes a shape; if it backed an existing text, keep that
        //object so Store.filterEmptyShapes can drop it together with its history
        if (existingText) {
          existingText.text = textValue;
          existingText.isEditing = false;
        }
        return;
      }

      if (existingText) {
        //the user edited an existing text: keep the very same object so every undo entry
        //that references it (and the selection) stays valid
        existingText.x = x;
        existingText.y = y;
        existingText.text = textValue;
        existingText.fontSize = fontSize;
        existingText.fontColor = input.style.color as StrokeColor;
        existingText.fontFamily = input.style.fontFamily;
        existingText.isEditing = false;
        existingText.stackIndex = Store.allShapes.indexOf(existingText);
        return;
      }

      const stackIndex = Store.allShapes.length;
      const text = new TextModel(
        x,
        y,
        textValue,
        fontSize,
        input.style.color as StrokeColor,
        input.style.fontFamily,
        stackIndex,
        id
      );

      Store.allShapes.splice(stackIndex, 0, text);
      UndoRedoService.push({
        type: UndoRedoEventType.CREATE,
        index: stackIndex,
        shape: {
          from: null,
          to: text,
        },
      });
    });

    //texts that no longer have an input are canvas shapes again
    const remainingIds = new Set(
      TextModel.getInputElements(parentDiv)
        .map((input) => input.dataset.textId)
        .filter((id): id is string => typeof id === 'string')
    );
    Store.getTextShapes().forEach((text) => {
      if (!remainingIds.has(text.id)) {
        text.isEditing = false;
        text.stackIndex = Store.allShapes.indexOf(text);
      }
    });
  }

  static convertToHtml(parentDiv: HTMLElement) {
    //convert canvas text shapes to html input elements, keeping the shapes in the store
    //so undo/redo entries that reference them stay valid
    const inputById = new Map<string, HTMLDivElement>();
    TextModel.getInputElements(parentDiv).forEach((input) => {
      const id = input.dataset.textId;
      if (id && !inputById.has(id)) inputById.set(id, input);
    });

    Store.getTextShapes().forEach((text) => {
      const stackIndex = Store.allShapes.indexOf(text);
      let input = inputById.get(text.id);

      if (!input) {
        input = TextModel.createInput(
          text.x,
          text.y,
          text.fontSize,
          text.fontColor,
          text.fontFamily,
          parentDiv.clientWidth,
          parentDiv.clientHeight,
          stackIndex,
          text.id
        );
        input.innerText = text.text;
        parentDiv.appendChild(input);
      } else {
        inputById.delete(text.id);
        //keep programmatic state in sync without fighting the user while typing
        if (document.activeElement !== input && input.innerText !== text.text) {
          input.innerText = text.text;
        }
        input.style.left = `${text.x}px`;
        input.style.top = `${text.y}px`;
        input.style.fontSize = `${text.fontSize}px`;
        input.style.color = text.fontColor;
        input.style.fontFamily = text.fontFamily;
      }

      text.isEditing = true;
      text.stackIndex = stackIndex;
    });

    //inputs whose text shape no longer exists (for example removed by an undo) must go away;
    //pending inputs are the ones the text tool just created and have no shape yet
    inputById.forEach((input) => {
      if (input.dataset.pending === 'true') return;
      parentDiv.removeChild(input);
    });
  }

  static isAnyTextFocused(parentDiv: HTMLElement) {
    const allChildren = Array.from(parentDiv.children);

    const inputElements = allChildren.filter((child) => {
      return child.className === TextModel.TEXT_DIV_TAG;
    });

    return inputElements.some((inputElement) => {
      return document.activeElement === inputElement;
    });
  }

  static changeHtmlTextTheme(parentDiv: HTMLElement, theme: Theme) {
    // because it catches rgba value to only rgb if it has alpha value 1, so we have do some string manipulation
    const allChildren = Array.from(parentDiv.children);

    const inputElements = allChildren.filter((child) => {
      return child.className === TextModel.TEXT_DIV_TAG;
    });

    inputElements.forEach((inputElement) => {
      const input = inputElement as HTMLDivElement;
      let shade = input.style.color.split(',')[3];
      let baseColor = input.style.color as StrokeColor;
      if (shade === undefined) {
        shade = '1';
        baseColor = baseColor.replace('rgb', 'rgba').replace(')', ',1)') as StrokeColor;
      } else {
        shade = shade.replace(')', '');
      }

      //remove white spaces
      baseColor = baseColor
        .replaceAll(' ', '')
        .substring(0, baseColor.lastIndexOf(',') - 1) as StrokeColor;

      if (StrokeColor.Black.includes(baseColor) || StrokeColor.White.includes(baseColor)) {
        input.style.color =
          theme === Theme.Dark
            ? (StrokeColor.White.replace('1)', shade + ')') as StrokeColor)
            : (StrokeColor.Black.replace('1)', shade + ')') as StrokeColor);
      }
    });
  }
}

export default TextModel;

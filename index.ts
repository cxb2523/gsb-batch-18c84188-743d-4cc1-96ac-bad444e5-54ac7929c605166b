import { Leafer, Rect, DragEvent, ResizeEvent } from 'leafer-ui'
import { BoundedDrag, IPoint, ISize } from './drag-bounds'

const leafer = new Leafer({ view: window })

const rect = new Rect({
    x: 100,
    y: 100,
    width: 100,
    height: 100,
    fill: '#32cd79',
    draggable: true
})

leafer.add(rect)

// 画布可视尺寸（view: window 时即窗口尺寸）
function viewSize(): ISize {
    return {
        width: leafer.width || window.innerWidth,
        height: leafer.height || window.innerHeight
    }
}

// 事件中的指针位置 -> 画布（leafer 内部）坐标
function eventPoint(e: DragEvent): IPoint {
    const p = e.getInnerPoint(leafer)
    return { x: p.x, y: p.y }
}

// 受限拖拽控制器：约束只依赖「当前指针位置 + 最新边界」
const drag = new BoundedDrag(viewSize(), { width: rect.width, height: rect.height }, pos => rect.set(pos))

// 拖拽事件：只负责提供指针位置
rect.on(DragEvent.START, (e: DragEvent) => {
    drag.dragStart(eventPoint(e), { x: rect.x, y: rect.y })
})

rect.on(DragEvent.DRAG, (e: DragEvent) => {
    drag.dragMove(eventPoint(e))
})

rect.on(DragEvent.END, () => {
    drag.dragEnd()
})

// resize 事件：只负责更新边界；若正在拖拽则立即按新边界收敛
function onResize(): void {
    drag.resize(viewSize())
}

leafer.on(ResizeEvent.RESIZE, onResize)
window.addEventListener('resize', onResize)

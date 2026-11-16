/**
 * drag-bounds.ts
 *
 * 受限拖拽的纯逻辑模块，不依赖 leafer-ui，可独立测试。
 *
 * 设计要点：约束计算只依赖一份状态 —— 「当前指针位置 + 最新边界」。
 * 拖拽事件负责更新指针位置，resize 事件负责更新边界，
 * 两路事件都只写自己的字段，再触发同一次约束计算，
 * 因此缩放瞬间不会把矩形跳回旧位置；未拖拽时 resize 只更新边界，不移动矩形。
 */

export interface IPoint {
    x: number
    y: number
}

export interface ISize {
    width: number
    height: number
}

/**
 * 单轴约束：
 * - 矩形尺寸 >= 可视尺寸时，对齐 0（左上角对齐），允许剩余部分溢出，绝不产生负坐标；
 * - 否则把位置钳制在 [0, bound - size]。
 * 该函数是幂等的：对同一输入重复调用结果不变，因此不会来回抖动。
 */
export function clampAxis(pos: number, size: number, bound: number): number {
    if (size >= bound) return 0
    if (pos < 0) return 0
    const max = bound - size
    return pos > max ? max : pos
}

/** 把矩形左上角位置钳制到可视边界内。 */
export function clampPosition(pos: IPoint, rect: ISize, bounds: ISize): IPoint {
    return {
        x: clampAxis(pos.x, rect.width, bounds.width),
        y: clampAxis(pos.y, rect.height, bounds.height),
    }
}

/**
 * 受限拖拽控制器（与 UI 框架无关）。
 *
 * 状态只有三份：
 * - bounds：最新可视边界（resize 事件唯一写入处）
 * - pointer：最近一次指针位置（拖拽事件唯一写入处，画布坐标系）
 * - grabOffset：按下瞬间指针相对矩形左上角的偏移（拖拽期间不变）
 *
 * 每次约束都用「pointer - grabOffset」算出期望位置，再按最新 bounds 钳制，
 * 通过 apply 回调把结果写回矩形。
 */
export class BoundedDrag {
    /** 最新可视边界，resize 时更新。 */
    bounds: ISize

    private pointer: IPoint = null
    private grabOffset: IPoint = null

    /**
     * @param bounds 初始可视边界
     * @param rectSize 矩形尺寸（约束期间视为不变）
     * @param apply 把约束后的位置写回矩形的回调
     */
    constructor(
        bounds: ISize,
        private rectSize: ISize,
        private apply: (pos: IPoint) => void
    ) {
        this.bounds = { ...bounds }
    }

    get dragging(): boolean {
        return this.grabOffset !== null
    }

    /** 拖拽开始：记录指针位置与抓取偏移，不移动矩形。 */
    dragStart(pointer: IPoint, rectPos: IPoint): void {
        this.pointer = { ...pointer }
        this.grabOffset = {
            x: pointer.x - rectPos.x,
            y: pointer.y - rectPos.y,
        }
    }

    /** 拖拽移动：更新指针位置并实时约束。 */
    dragMove(pointer: IPoint): void {
        if (!this.dragging) return
        this.pointer = { ...pointer }
        this.constrain()
    }

    /** 拖拽结束：清除拖拽状态，边界保留。 */
    dragEnd(): void {
        this.pointer = null
        this.grabOffset = null
    }

    /**
     * 可视边界变化：只更新边界；
     * 若正在拖拽，立即用「当前指针位置 + 新边界」重新约束，让矩形收敛到新边界内。
     */
    resize(bounds: ISize): void {
        this.bounds = { ...bounds }
        if (this.dragging) this.constrain()
    }

    /** 约束计算的唯一入口：期望位置 = 当前指针位置 - 抓取偏移，再按最新边界钳制。 */
    private constrain(): void {
        const desired: IPoint = {
            x: this.pointer.x - this.grabOffset.x,
            y: this.pointer.y - this.grabOffset.y,
        }
        this.apply(clampPosition(desired, this.rectSize, this.bounds))
    }
}

import { describe, it, expect } from 'vitest'
import { BoundedDrag, clampAxis, clampPosition, IPoint, ISize } from '../../drag-bounds'

/**
 * 自造的本地样例：用一个「假矩形」记录每次被写入的位置，
 * 模拟 拖拽事件流 与 resize 事件流 两条独立事件来源，
 * 验证越界实时收敛与窗口缩放后的边界更新。
 */
function createDemo(bounds: ISize, rectSize: ISize) {
    const rect = {
        pos: { x: 100, y: 100 } as IPoint,
        size: rectSize,
        /** 每一次 apply 写入的历史位置，用于验证“实时”约束 */
        history: [] as IPoint[],
    }
    const drag = new BoundedDrag(bounds, rect.size, pos => {
        rect.pos = { ...pos }
        rect.history.push({ ...pos })
    })
    return { rect, drag }
}

describe('clampAxis / clampPosition', () => {
    it('把位置钳制在 [0, bound - size]', () => {
        expect(clampAxis(-50, 100, 800)).toBe(0)
        expect(clampAxis(750, 100, 800)).toBe(700)
        expect(clampAxis(300, 100, 800)).toBe(300)
    })

    it('矩形大于可视区时对齐 0，不产生负坐标', () => {
        expect(clampAxis(120, 1000, 800)).toBe(0)
        expect(clampAxis(-30, 1000, 800)).toBe(0)
        expect(clampPosition({ x: 50, y: -10 }, { width: 2000, height: 900 }, { width: 800, height: 600 }))
            .toEqual({ x: 0, y: 0 })
    })

    it('幂等：重复钳制结果不变（不会来回抖动）', () => {
        const bounds = { width: 800, height: 600 }
        const size = { width: 100, height: 100 }
        const once = clampPosition({ x: 9999, y: -9999 }, size, bounds)
        expect(clampPosition(once, size, bounds)).toEqual(once)
    })
})

describe('BoundedDrag：拖拽越界实时收敛', () => {
    it('拖拽过程中每一次移动都被约束在边界内，而不是结束后才纠正', () => {
        const { rect, drag } = createDemo({ width: 800, height: 600 }, { width: 100, height: 100 })

        drag.dragStart({ x: 150, y: 150 }, rect.pos) // 抓在矩形内 (50, 50) 处
        drag.dragMove({ x: 500, y: 400 })            // 界内
        drag.dragMove({ x: 2000, y: 400 })           // 右越界
        drag.dragMove({ x: 2000, y: 2000 })          // 右下越界
        drag.dragMove({ x: -500, y: -500 })          // 左上越界

        // 每一次 apply 的位置都必须在边界内（实时约束）
        expect(rect.history).toEqual([
            { x: 450, y: 350 },
            { x: 700, y: 350 },  // 800 - 100
            { x: 700, y: 500 },  // 600 - 100
            { x: 0, y: 0 },
        ])
        expect(rect.pos).toEqual({ x: 0, y: 0 })
        drag.dragEnd()
    })

    it('矩形大于可视区时按左上角对齐并允许溢出，不出现负坐标或抖动', () => {
        const { rect, drag } = createDemo({ width: 300, height: 200 }, { width: 500, height: 400 })

        drag.dragStart({ x: 250, y: 150 }, { x: 0, y: 0 })
        drag.dragMove({ x: 100, y: 80 })   // 期望位置 (-150, -70) -> 钳到 (0, 0)
        drag.dragMove({ x: 100, y: 80 })   // 同一指针位置重复触发 -> 结果恒定，不抖动
        drag.dragMove({ x: 9999, y: 9999 })

        expect(rect.history).toEqual([
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
        ])
        expect(rect.pos).toEqual({ x: 0, y: 0 })
        drag.dragEnd()
    })
})

describe('BoundedDrag：窗口缩放与拖拽两条事件来源', () => {
    it('拖拽中窗口缩小：立即按新边界收敛，不等拖拽结束', () => {
        const { rect, drag } = createDemo({ width: 800, height: 600 }, { width: 100, height: 100 })

        drag.dragStart({ x: 150, y: 150 }, rect.pos)
        drag.dragMove({ x: 750, y: 550 }) // 矩形在 (700, 500)，贴着旧边界
        expect(rect.pos).toEqual({ x: 700, y: 500 })

        drag.resize({ width: 400, height: 300 }) // 窗口缩小，指针不动
        expect(rect.pos).toEqual({ x: 300, y: 200 }) // 立即收敛到新边界内

        drag.dragEnd()
    })

    it('拖拽中窗口放大：按「当前指针位置 + 新边界」计算，不跳回旧位置', () => {
        const { rect, drag } = createDemo({ width: 800, height: 600 }, { width: 100, height: 100 })

        drag.dragStart({ x: 150, y: 150 }, rect.pos)
        drag.dragMove({ x: 900, y: 700 }) // 被旧边界钳在 (700, 500)
        expect(rect.pos).toEqual({ x: 700, y: 500 })

        drag.resize({ width: 1200, height: 900 }) // 窗口放大：同一指针位置重新约束
        expect(rect.pos).toEqual({ x: 850, y: 650 }) // 指针 (900,700) - 抓取偏移 (50,50)

        drag.dragMove({ x: 2000, y: 2000 }) // 继续拖拽，按新边界钳制
        expect(rect.pos).toEqual({ x: 1100, y: 800 })
        drag.dragEnd()
    })

    it('缩放瞬间约束结果稳定：重复 resize 不抖动', () => {
        const { rect, drag } = createDemo({ width: 800, height: 600 }, { width: 100, height: 100 })

        drag.dragStart({ x: 150, y: 150 }, rect.pos)
        drag.dragMove({ x: 750, y: 550 })
        drag.resize({ width: 400, height: 300 })
        drag.resize({ width: 400, height: 300 }) // 重复事件（window + leafer 双监听）

        expect(rect.pos).toEqual({ x: 300, y: 200 })
        expect(rect.history.filter(p => p.x === 300 && p.y === 200).length).toBe(2)
        drag.dragEnd()
    })

    it('未拖拽时 resize 只更新边界，不移动矩形', () => {
        const { rect, drag } = createDemo({ width: 800, height: 600 }, { width: 100, height: 100 })

        drag.resize({ width: 400, height: 300 })
        expect(rect.pos).toEqual({ x: 100, y: 100 }) // 位置不变
        expect(rect.history.length).toBe(0)          // 没有触发任何写入

        // 但新边界已生效：之后的拖拽按新边界约束
        drag.dragStart({ x: 150, y: 150 }, rect.pos)
        drag.dragMove({ x: 900, y: 900 })
        expect(rect.pos).toEqual({ x: 300, y: 200 })
        drag.dragEnd()
    })
})

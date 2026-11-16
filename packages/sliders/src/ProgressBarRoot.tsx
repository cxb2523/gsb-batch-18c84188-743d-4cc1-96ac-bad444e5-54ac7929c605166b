import { SliderRoot } from './SliderRoot';
import { useHover } from '@react-aria/interactions';
import { mergeProps } from '@react-aria/utils';
import React, { ComponentProps, ComponentPropsWithoutRef, createContext, forwardRef, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, RefAttributes, RefObject, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useMediaBuffered, useMediaCurrentTimeFine, useMediaDuration, useMediaPendingSeek } from '@react-av/core';

export interface ProgressBarTooltipContextState {
    percentage: number;
    root: RefObject<HTMLSpanElement | null>;
    show: boolean;
};

export const ProgressBarTooltipContext = createContext<ProgressBarTooltipContextState | undefined>(undefined);

export function useMediaProgressBarTooltip() {
    const context = useContext(ProgressBarTooltipContext);
    if (!context) throw new Error('useMediaProgressBarTooltip must be used within a ProgressBarTooltipContext');
    return context;
}

export type ProgressBarRootProps = Omit<ComponentProps<typeof SliderRoot>, "onValueChange" | "value" | "max" | "min"> & ComponentPropsWithoutRef<'span'>;

export const ProgressBarRoot: React.ForwardRefExoticComponent<ProgressBarRootProps & RefAttributes<HTMLSpanElement>> = forwardRef<HTMLSpanElement, ProgressBarRootProps>(function ProgressBarRoot({children, disabled, step = 0.001, keyboardStep = 1, onPointerDown, ...props}, ref) {
    const [currentTime, seek] = useMediaCurrentTimeFine();
    const [pendingSeek, , { beginInteraction, endInteraction }] = useMediaPendingSeek();
    const internalRef = useRef<HTMLSpanElement>(null);
    // Tracks the gesture that owns the active interaction. Pointer and
    // keyboard adjustment are separate flows: a window pointerup belonging to
    // no drag must never end a keyboard session, and a keyboard commit must
    // never be misclassified as a pointer gesture.
    const gestureRef = useRef<"none" | "pointer" | "keyboard">("none");
    const duration = useMediaDuration();
    const buffered = useMediaBuffered();
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const [state, setState] = useState<ProgressBarTooltipContextState>({
        percentage: 0,
        root: internalRef,
        show: false,
    });

    const {isHovered, hoverProps} = useHover({ isDisabled: disabled || !hasDuration });

    useEffect(() => {
        setState(state => ({
            ...state,
            show: isHovered,
        }));
    }, [isHovered]);

    // While the user is dragging or adjusting with the keyboard, the slider
    // value is their target time and it must never be clamped or overwritten by
    // playback events. When no interaction is in flight, clamp the displayed
    // time to the buffered ranges so buffer changes cannot leave the UI stuck
    // at a time that is no longer playable.
    const displayTime = pendingSeek !== null
        ? pendingSeek
        : clampTimeToRanges(currentTime, duration, buffered);

    // Keep the hover preview in sync with the displayed time whenever the
    // media's buffered ranges move (progress events) or time updates. Mouse
    // moves and user interaction update it directly and take precedence.
    useEffect(() => {
        if (!hasDuration) {
            setState(state => state.percentage === 0 ? state : { ...state, percentage: 0 });
            return;
        }
        const percentage = displayTime / duration;
        setState(state => state.percentage === percentage ? state : { ...state, percentage });
    }, [displayTime, duration, hasDuration]);

    // Pointer capture can be released without Radix emitting a commit (e.g.
    // the interaction is cancelled). Always close an active pointer session on
    // the window-level pointer end events as a safety net. The gesture ref
    // keeps this a no-op for keyboard sessions and unrelated pointer events, so
    // a stray pointerup can never re-arm or tear down the wrong interaction.
    const stopPointerInteraction = useCallback(() => {
        if (gestureRef.current !== "pointer") return;
        gestureRef.current = "none";
        endInteraction();
    }, [endInteraction]);

    const stopKeyboardInteraction = useCallback(() => {
        if (gestureRef.current !== "keyboard") return;
        gestureRef.current = "none";
        endInteraction();
    }, [endInteraction]);

    useEffect(() => {
        window.addEventListener('pointerup', stopPointerInteraction);
        window.addEventListener('pointercancel', stopPointerInteraction);
        return () => {
            window.removeEventListener('pointerup', stopPointerInteraction);
            window.removeEventListener('pointercancel', stopPointerInteraction);
        };
    }, [stopPointerInteraction]);

    // TODO: vertical
    function handleMouseMove(e: MouseEvent<HTMLDivElement>) {
        const cursor = e.clientX;
        const rect = internalRef.current?.getBoundingClientRect();
        if (!rect) return;
        if (cursor < rect.left || cursor > rect.right) return;
        const percentage = (cursor - rect.left) / rect.width;
        setState(state => ({
            ...state, percentage
        }));
    }

    function handlePointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
        onPointerDown?.(e);
        if (disabled || !hasDuration || e.defaultPrevented) return;
        gestureRef.current = "pointer";
        beginInteraction();
    }

    const keyboardKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];
    function handleKeyDown(e: KeyboardEvent<HTMLSpanElement>) {
        if (disabled || !hasDuration || e.defaultPrevented) return;
        if (!keyboardKeys.includes(e.key)) return;
        gestureRef.current = "keyboard";
        beginInteraction();
    }

    return <ProgressBarTooltipContext.Provider value={state}>
        <SliderRoot
            ref={current => {
                if (typeof ref === "function") ref(current);
                // @ts-ignore
                else if (ref) ref.current = current;
                // @ts-ignore
                internalRef.current = current;
            }}
            keyboardStep={keyboardStep} {...mergeProps(props, hoverProps)}
            onPointerDown={handlePointerDown}
            onKeyDown={handleKeyDown}
            onMouseMove={handleMouseMove}
            onValueChange={value => {
                const time = value[0];
                if (time === undefined || !hasDuration) return;
                // The interaction session is opened at the event boundary
                // (handlePointerDown / handleKeyDown), which Radix always
                // dispatches before this callback. Radix can also invoke this
                // after onValueCommit within the same gesture, so it must not
                // open or re-open a session here.
                seek(time);
                setState(state => ({
                    ...state,
                    percentage: time / duration,
                }));
            }}
            onValueCommit={() => {
                if (gestureRef.current === "keyboard") {
                    stopKeyboardInteraction();
                } else {
                    stopPointerInteraction();
                }
            }}
            disabled={disabled || !hasDuration}
            value={[hasDuration ? displayTime : 0]}
            min={0} max={hasDuration ? duration : 1} step={step}
        >
            {children}
        </SliderRoot>
    </ProgressBarTooltipContext.Provider>;
});

function clampTimeToRanges(
    time: number,
    duration: number,
    buffered: TimeRanges | null,
): number {
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time)) return 0;
    if (!buffered || buffered.length === 0) return time;
    for (let i = 0; i < buffered.length; i++) {
        const start = buffered.start(i);
        const end = buffered.end(i);
        if (time >= start && time <= end) return time;
    }
    // The time lies outside every buffered range: snap to the nearest edge.
    let nearest = buffered.start(0);
    let nearestDistance = Math.abs(time - nearest);
    for (let i = 0; i < buffered.length; i++) {
        const start = buffered.start(i);
        const end = buffered.end(i);
        if (Math.abs(time - start) < nearestDistance) {
            nearest = start;
            nearestDistance = Math.abs(time - start);
        }
        if (Math.abs(time - end) < nearestDistance) {
            nearest = end;
            nearestDistance = Math.abs(time - end);
        }
    }
    return Math.min(Math.max(nearest, 0), duration);
}

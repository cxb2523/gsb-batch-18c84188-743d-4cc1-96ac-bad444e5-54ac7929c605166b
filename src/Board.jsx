import { useState, useEffect } from "react";
import ToolBar from "./components/Toolbar";
import Steps from "./components/Steps";
import TrackList from "./components/TrackList";
import PlayHead from "./components/PlayHead";
import { Provider } from "./Provider";
import useTimer from "./hooks/useTimer";
import useStyles from "./hooks/useStyles";
import { MIN_BPM, MAX_BPM } from "./constants/config";
import "./Board.css";

function Board() {
  const baseBPMPerOneSecond = 60;
  const stepsPerBar = 8;
  const beatsPerBar = 4;
  const barsPerSequence = 2;
  const totalSteps = stepsPerBar * barsPerSequence;
  const totalBeats = beatsPerBar * barsPerSequence;

  const [BPM, setBPM] = useState(120);
  const [startTime, setStartTime] = useState(null);
  const [pastLapsedTime, setPastLapse] = useState(0);
  const [currentStepID, setCurrentStep] = useState(null);
  const [playbackResetKey, setPlaybackResetKey] = useState(0);
  const [getNotesAreaWidthInPixels] = useStyles(totalSteps);

  const notesAreaWidthInPixels = getNotesAreaWidthInPixels(totalSteps);
  const timePerSequence = (baseBPMPerOneSecond / BPM) * 1000 * totalBeats;
  const timePerStep = timePerSequence / totalSteps;
  const isSequencePlaying = startTime !== null;
  const playerTime = useTimer(isSequencePlaying);
  const lapsedTime = isSequencePlaying
    ? Math.max(0, playerTime - startTime)
    : 0;
  const totalLapsedTime = pastLapsedTime + lapsedTime;

  useEffect(() => {
    if (isSequencePlaying) {
      setCurrentStep(Math.floor(totalLapsedTime / timePerStep) % totalSteps);
    } else {
      setCurrentStep(null);
    }
  }, [isSequencePlaying, timePerStep, totalLapsedTime, totalSteps]);

  // BPM 只允许落在 [MIN_BPM, MAX_BPM];非法输入直接忽略(由 Toolbar 保证不回传),
  // 这里再兜底一次。播放中修改时按 timePerStep ∝ 1/BPM 缩放已走过的时间,
  // 使步进度(totalLapsedTime / timePerStep)在新速度下连续,不跳步、不倒退。
  const changeBPM = (nextBPM) => {
    const parsed = Number(nextBPM);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, parsed));
    if (clamped === BPM) return;
    const ratio = BPM / clamped;
    if (isSequencePlaying) {
      const now = performance.now();
      const elapsed = pastLapsedTime + Math.max(0, now - startTime);
      setPastLapse(elapsed * ratio);
      setStartTime(now);
    } else {
      setPastLapse((past) => past * ratio);
    }
    setBPM(clamped);
  };

  const stopPlayback = () => {
    setPastLapse(0);
    setStartTime(null);
    setPlaybackResetKey((k) => k + 1);
  };

  const toolBarProps = {
    setStartTime,
    setPastLapse,
    onBPMChange: changeBPM,
    stopPlayback,
    isSequencePlaying,
    startTime,
    BPM,
  };

  const playHeadProps = {
    notesAreaWidthInPixels,
    timePerSequence,
    totalLapsedTime,
  };

  const trackListProps = {
    currentStepID,
    playbackResetKey,
  };

  return (
    <Provider>
      <main className="app">
        <header className="app_header">
          <h1 className="app_title">REACT 808 🎹</h1>
          <ToolBar {...toolBarProps} />
        </header>
        <Steps count={totalSteps} />
        <div className="app_content">
          <PlayHead {...playHeadProps} />
          <TrackList {...trackListProps} />
        </div>
        <footer className="app_footer">
          Source code on{" "}
          <a href="https://github.com/PLUSDEVLLC/react808.com">on Github</a>,
          Built by <a href="http://seifi.org/">Joe Seifi</a> using React.js
        </footer>
      </main>
    </Provider>
  );
}

export default Board;

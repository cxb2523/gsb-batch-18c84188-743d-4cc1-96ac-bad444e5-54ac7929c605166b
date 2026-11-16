import { useContext, useEffect, useRef, useMemo, memo } from "react";
import { Context } from "../Provider";
import { soundFiles } from "../constants/config";
import Sound from "../utils/Sound";
import Track from "./Track";

const TrackList = ({ currentStepID, playbackResetKey }) => {
  const {
    sequence: { trackList, noteCount },
  } = useContext(Context);

  // 每个 soundFile 懒加载一个共享的 Sound 实例(首次真正播放时才创建,
  // 避免在渲染期产生 AudioContext 副作用)。
  const playersRef = useRef({});
  const lastPlayedStepRef = useRef(null);

  const trackPlayers = useMemo(
    () =>
      trackList.map((track) => () => {
        const key = track.soundFile;
        let player = playersRef.current[key];
        if (!player) {
          const sound = new Sound(soundFiles[key]);
          player = { play: () => sound.play() };
          playersRef.current[key] = player;
        }
        player.play();
      }),
    [trackList]
  );

  // 停止后从头开始:复位"已触发步"记录,重新播放时第 0 步会正常发声
  useEffect(() => {
    lastPlayedStepRef.current = null;
  }, [playbackResetKey]);

  // 发声与高亮共用同一个 currentStepID(同一套步进判定)。
  // 同一步只触发一次;暂停时 currentStepID 为 null 不触发,
  // 继续播放时从当前步接着走,不补发暂停期间错过的音符;
  // 切换序列只更换 trackList,播放位置不变,当前步不会重复触发。
  useEffect(() => {
    if (currentStepID === null) return;
    if (lastPlayedStepRef.current === currentStepID) return;
    lastPlayedStepRef.current = currentStepID;
    trackList.forEach((track, trackID) => {
      if (track.onNotes.indexOf(currentStepID) !== -1) {
        trackPlayers[trackID]();
      }
    });
  }, [currentStepID, trackList, trackPlayers]);

  const content = trackList.map((track, trackID) => {
    const { title, onNotes } = track;

    return (
      <Track
        key={title}
        trackID={+trackID}
        currentStepID={currentStepID}
        title={title}
        noteCount={noteCount}
        onNotes={onNotes}
        play={trackPlayers[trackID]}
      />
    );
  });

  return <div className="track-list">{content}</div>;
};

export default memo(TrackList);

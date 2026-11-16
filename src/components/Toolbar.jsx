import { useContext, useState, memo } from "react";
import { sequenceList } from "../constants/config";
import { Context } from "../Provider";
import "./Toolbar.css";

const ToolBar = ({
  setStartTime,
  setPastLapse,
  onBPMChange,
  stopPlayback,
  isSequencePlaying,
  startTime,
  BPM,
}) => {
  const {
    sequence: { id: selectedSequenceID },
    selectSequence,
  } = useContext(Context);

  // 输入框文本与生效的 BPM 分离:文本允许任意键入,
  // 只有解析为有限数字时才提交;非法/空输入保留上一个有效 BPM。
  const [bpmText, setBpmText] = useState(String(BPM));

  function togglePlayback() {
    if (isSequencePlaying) {
      setPastLapse((l) => l + performance.now() - startTime);
      setStartTime(null);
    } else {
      setStartTime(performance.now());
    }
  }

  function updateBPM(e) {
    const text = e.target.value;
    setBpmText(text);
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed)) {
      onBPMChange(parsed);
    }
    // 非法或空输入:不提交,播放时钟继续使用上一个有效 BPM
  }

  function handleBPMBlur() {
    // 回退显示为当前生效的 BPM(非法输入或未钳制前的原始文本)
    setBpmText(String(BPM));
  }

  return (
    <nav className="toolbar">
      <button
        className="form_element button_stop"
        onClick={stopPlayback}
        aria-label="Stop"
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <rect
            className="button_icon_path"
            x="2"
            y="2"
            width="10"
            height="10"
          />
        </svg>
      </button>
      <button
        className="form_element button_play_pause"
        onClick={togglePlayback}
        aria-label="Play / Pause"
      >
        <svg width="14" height="14" viewBox="8 8 20 20">
          {isSequencePlaying && (
            <path
              className="button_icon_path"
              id="pause-icon"
              data-state="playing"
              d="M11,10 L17,10 17,26 11,26 M20,10 L26,10 26,26 20,26"
            />
          )}
          {!isSequencePlaying && (
            <path
              className="button_icon_path"
              id="play-icon"
              data-state="paused"
              d="M11,10 L18,13.74 18,22.28 11,26 M18,13.74 L26,18 26,18 18,22.28"
            />
          )}
        </svg>
      </button>
      <input
        className="form_element input_bpm"
        id="bpm"
        type="text"
        value={bpmText}
        onChange={updateBPM}
        onBlur={handleBPMBlur}
      />
      <label className="label_bpm" htmlFor="bpm">
        BPM
      </label>
      <select
        className="form_element select_sequence"
        value={selectedSequenceID}
        onChange={(e) => selectSequence(+e.target.value)}
        aria-label="Select sequence"
      >
        {sequenceList.map((seq) => {
          return (
            <option key={seq.id} value={seq.id}>
              {seq.title}
            </option>
          );
        })}
      </select>
    </nav>
  );
};

export default memo(ToolBar);

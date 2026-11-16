import { useContext, memo } from "react";
import classNames from "classnames";
import { Context } from "../Provider";
import "./Note.css";

// 发声触发已集中到 TrackList(与播放时钟共用同一套步进判定),
// Note 只负责渲染高亮和响应点击(点击时即时试听)。
const Note = ({ trackID, stepID, isNoteOn, isNoteOnCurrentStep, play }) => {
  const { toggleNote } = useContext(Context);
  const noteClassNames = classNames("note", {
    on: isNoteOn,
    playing: isNoteOn && isNoteOnCurrentStep,
  });

  const noteClicked = (e) => {
    e.target.classList.toggle("on");
    toggleNote({ trackID, stepID });
    play();
  };

  return <div className={noteClassNames} onClick={noteClicked} />;
};

export default memo(Note);

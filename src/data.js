/*
 * 本地验证用示例数据。
 *
 * 关键点：
 *   - 四段来自同一视频源的不同区间，片段之间不是首尾相接，
 *     因此跳转时“段内偏移”算错就会明显错位（画面与进度条对不上）。
 *   - 最后一段末尾（24.72）与总时长 21.12 的关系需要特别覆盖：
 *     这是“拖到最后一段末尾/片尾重播”的验证入口。
 *
 * 片段时长：3.12 / 5.88 / 8.92 / 3.2，累计终点：3.12 / 9 / 17.92 / 21.12
 */
const videoObj = {
  logo: "//cms-static.pengwin.com/data/product_logo/20210713/2671411626148786627659.png",
  thumb:
    "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
  list: [
    {
      id: 352,
      name: "简单充充_衻_1038",
      url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
      thumb:
        "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
      width: 1080,
      height: 1920,
      logoPosition: {
        x: "left",
        y: "top",
      },
      playPoint: {
        end: "3.120000",
        start: "0",
      },
      index: 0,
    },
    {
      id: 352,
      name: "简单充充_衻_1038",
      url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
      thumb:
        "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
      width: 1080,
      height: 1920,
      logoPosition: {
        x: "right",
        y: "top",
      },
      playPoint: {
        end: "10.200000",
        start: "4.320000",
      },
      index: 1,
    },
    {
      id: 352,
      name: "简单充充_衻_1038",
      url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
      thumb:
        "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
      width: 1080,
      height: 1920,
      logoPosition: {
        x: "left",
        y: "bottom",
      },
      playPoint: {
        end: "20.320000",
        start: "11.400000",
      },
      index: 2,
    },
    {
      id: 352,
      name: "简单充充_衻_1038",
      url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
      thumb:
        "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
      width: 1080,
      height: 1920,
      logoPosition: {
        x: "right",
        y: "bottom",
      },
      playPoint: {
        end: "24.72",
        start: "21.520000",
      },
      index: 3,
    },
  ],
  // 所有片段累计总时长（3.12 + 5.88 + 8.92 + 3.2）
  duration: 21.12,
  common: 1,
  name: "简单充充_01_0713",
};

export default videoObj;

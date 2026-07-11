window.DEFAULT_APP_CONFIG = {
  provider: {
    label: "API Market",
    models: [
      {
        value: "gpt-image-2",
        label: "快速低价版",
        note: "适合草稿、批量试图和内容配图。"
      },
      {
        value: "gpt-image-2-official",
        label: "官方完整版",
        note: "支持质量、分辨率、比例、格式和多图控制。"
      }
    ]
  },
  defaults: {
    model: "gpt-image-2",
    aspectRatio: "1:1",
    resolution: "1k",
    quality: "low",
    outputFormat: "png",
    outputCompression: 90,
    imageCount: 1
  },
  polling: {
    intervalMs: 4000,
    initialDelayMs: 10000,
    timeoutMs: 240000
  }
};

window.APP_CONFIG = window.DEFAULT_APP_CONFIG;

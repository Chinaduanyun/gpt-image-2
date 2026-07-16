(() => {
  const ns = window.ImageGen = window.ImageGen || {};
  const config = window.APP_CONFIG || window.DEFAULT_APP_CONFIG || {};

  ns.config = config;
  ns.defaults = config.defaults || {};
  ns.polling = config.polling || {};
  ns.constants = {
    MAX_REFERENCE_IMAGES: 16,
    MAX_REFERENCE_IMAGE_BYTES: 5 * 1024 * 1024,
    MAX_REFERENCE_TOTAL_BYTES: 18 * 1024 * 1024,
    MODEL_NOTES: {
      'gpt-image-2': '快速低价版：适合草稿、批量试图和内容配图。价格按分辨率档位简单估算。',
      'gpt-image-2-official': '官方完整版：支持质量、分辨率、比例和多图控制。价格按实际像素和质量档位估算。'
    }
  };

  ns.state = {
    result: null,
    session: null,
    adminVisible: false,
    progressTimer: null,
    progressStartedAt: 0,
    referenceImages: [],
    myLogs: [],
    historySearch: '',
    historyFilter: 'all',
    currentGenerationStep: '',
    isBusy: false,
    publicConfig: null,
    pendingRequest: null,
    pollController: null,
    lastLiveAnnouncement: '',
    lastResultFocusId: '',
    activeOperationToken: '',
    submitController: null,
    accountEpoch: 0,
    loginAttemptId: 0
  };

  ns.generationStepOrder = ['validate', 'submit', 'queued', 'poll', 'result', 'done'];
})();

// GEO AI发布助手 - 配置模块
// 从脚本管理中心注入的参数中读取配置
(function() {
  const params = window.__SCRIPT_PARAMS__ || {};
  window.GEO_CONFIG = {
    providerMode: params.providerMode || 'mock',
    cozeApiUrl: params.cozeApiUrl || 'https://phpdev.66wz.com/api/coze-proxy.php',
    cozeWorkflowId: params.cozeWorkflowId || '',
    cozeAppKey: params.cozeAppKey || '',
    cozeAppSecret: params.cozeAppSecret || '',
    dmxApiUrl: params.dmxApiUrl || 'https://api.dmxapi.com/v1/chat/completions',
    dmxModel: params.dmxModel || 'deepseek-v4-pro',
    dmxApiKey: params.dmxApiKey || '',
    dmxCustomModel: params.dmxCustomModel || '',
    apiBaseUrl: params.apiBaseUrl || 'https://phpdev.66wz.com/api',
  };
})();

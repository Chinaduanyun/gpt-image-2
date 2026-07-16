const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { API_MARKET_BASE_URL, ROOT } = require('./constants');

function loadLocalConfig() {
  const filePath = path.join(ROOT, 'config.local.js');
  if (!fs.existsSync(filePath)) return {};

  try {
    const sandbox = { window: {} };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), sandbox, {
      filename: 'config.local.js',
      timeout: 100
    });
    return sandbox.window.APP_CONFIG || sandbox.window.DEFAULT_APP_CONFIG || {};
  } catch {
    return {};
  }
}

function getLocalApiMarketConfig() {
  const localConfig = loadLocalConfig();
  const apiMarket = localConfig?.providers?.apiMarket || localConfig?.apiMarket || {};
  return {
    apiKey: apiMarket.apiKey || apiMarket.key || '',
    baseUrl: apiMarket.baseUrl || '',
    model: apiMarket.model || localConfig?.provider?.model || ''
  };
}

function loadApiMarketConfig() {
  const local = getLocalApiMarketConfig();
  return {
    apiKey: process.env.API_MARKET_API_KEY || process.env.APIMARKET_API_KEY || local.apiKey,
    baseUrl: process.env.API_MARKET_BASE_URL || process.env.APIMARKET_BASE_URL || local.baseUrl || API_MARKET_BASE_URL,
    model: process.env.API_MARKET_MODEL || process.env.APIMARKET_MODEL || local.model || 'gpt-image-2'
  };
}

module.exports = {
  loadLocalConfig,
  getLocalApiMarketConfig,
  loadApiMarketConfig
};

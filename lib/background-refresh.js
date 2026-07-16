const { loadApiMarketConfig } = require('./api-market-config');
const { sanitizeErrorMessage } = require('./api-market-client');
const { loadDataStore, withDataStoreMutation } = require('./store');
const { logNeedsRefresh, refreshLogsFromUpstream, markStaleSubmittingUnknown } = require('./spend-logs');

let backgroundRefreshInFlight = false;

async function refreshPendingLogsInBackground() {
  if (backgroundRefreshInFlight) return;
  backgroundRefreshInFlight = true;
  try {
    await withDataStoreMutation((latestData) => markStaleSubmittingUnknown(latestData));
    const config = loadApiMarketConfig();
    if (!config.apiKey?.trim()) return;
    const data = loadDataStore();
    const logs = data.spendLogs.slice().reverse().filter(logNeedsRefresh);
    if (!logs.length) return;
    await refreshLogsFromUpstream(data, logs, config, 50);
  } catch (error) {
    console.error(`Background task refresh failed: ${sanitizeErrorMessage(error)}`);
  } finally {
    backgroundRefreshInFlight = false;
  }
}

module.exports = {
  refreshPendingLogsInBackground
};

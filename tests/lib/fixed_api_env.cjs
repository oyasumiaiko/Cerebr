const fsp = require('fs/promises');
const path = require('path');

/**
 * 解析仓库根目录 `.env`。
 *
 * 这里故意保持为零依赖实现，避免为了浏览器回归脚本再引入额外 dotenv 运行时依赖。
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseDotEnv(content) {
  const env = {};
  String(content || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) return;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const unquoted = (
        (rawValue.startsWith('"') && rawValue.endsWith('"'))
        || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
      )
        ? rawValue.slice(1, -1)
        : rawValue;
      env[key] = unquoted;
    });
  return env;
}

/**
 * 加载仓库约定的固定 live API 环境。
 *
 * 说明：
 * - 当前默认从仓库根目录 `.env` 读取；
 * - 缺项时直接抛错，避免浏览器 live smoke 在半配置状态下误跑。
 *
 * @param {string} repoRootPath
 * @returns {Promise<{
 *   responsesBaseUrl: string,
 *   responsesApiKey: string,
 *   geminiBaseUrl: string,
 *   geminiApiKey: string
 * }>}
 */
async function loadFixedApiEnv(repoRootPath) {
  const envPath = path.join(repoRootPath, '.env');
  const content = await fsp.readFile(envPath, 'utf8');
  const env = parseDotEnv(content);
  const required = (key) => {
    const value = (typeof env[key] === 'string') ? env[key].trim() : '';
    if (!value) {
      throw new Error(`.env 缺少必填项 ${key}`);
    }
    return value;
  };
  const optional = (key) => {
    const value = (typeof env[key] === 'string') ? env[key] : '';
    return value.trim();
  };
  return {
    responsesBaseUrl: required('CEREBR_FIXED_RESPONSES_BASE_URL'),
    responsesApiKey: required('CEREBR_FIXED_RESPONSES_API_KEY'),
    geminiBaseUrl: required('CEREBR_FIXED_GEMINI_BASE_URL'),
    geminiApiKey: optional('CEREBR_FIXED_GEMINI_API_KEY')
  };
}

module.exports = {
  parseDotEnv,
  loadFixedApiEnv
};

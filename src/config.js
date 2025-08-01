/**
 * 配置管理器
 * 负责处理环境变量和全局配置
 */
export class ConfigManager {
  // 默认配置
  static DEFAULT_CONFIG = {
    // 认证令牌，务必在此处或填入环境变量来修改
    AUTH_TOKEN: "your-auth-token",
    // 默认目标URL
    DEFAULT_DST_URL: "https://httpbin.org/get",
    // 调试模式，默认关闭
    DEBUG_MODE: false,
    // 主代理策略
    PROXY_STRATEGY: "socket",
    // 回退策略，当主策略不可用时将请求转发到回退策略
    // 可选fetch, socks5, thirdparty, cloudprovider，只对HTTP请求有效
    // 对于普通用户，建议使用fetch作为回退策略
    // 对于希望保护隐私，但不方便自建socks5或第三方代理的用户，建议使用cloudprovider策略
    // 对于需要严格保护隐私的用户且有条件自建socks5或第三方代理的用户，建议使用socks5或thirdparty策略
    FALLBACK_PROXY_STRATEGY: "fetch",

    // 代理IP
    //PROXY_IP: "", //暂未实现，请勿填写

    // SOCKS5代理地址，格式 "host:port"
    SOCKS5_ADDRESS: "",
    // thirdparty策略的代理地址
    THIRD_PARTY_PROXY_URL: "",
    // 其他云服务商函数URL
    CLOUD_PROVIDER_URL: "",
    // DoH服务器配置，默认使用Google的DoH服务器
    DOH_SERVER_HOSTNAME: "dns.google",
    DOH_SERVER_PORT: 443,
    DOH_SERVER_PATH: "/dns-query",
    // DoT服务器配置，默认使用Google的DoT服务器
    DOT_SERVER_HOSTNAME: "dns.google",
    DOT_SERVER_PORT: 853,
  };

  /**
   * 从环境变量更新配置
   * @param {object} env - 环境变量对象
   * @returns {object} 更新后的配置
   */
  static updateConfigFromEnv(env) {
    if (!env) return { ...this.DEFAULT_CONFIG };
    
    const config = { ...this.DEFAULT_CONFIG };
    
    for (const key of Object.keys(config)) {
      if (key in env) {
        if (typeof config[key] === 'boolean') {
          config[key] = env[key] === 'true';
        } else {
          config[key] = env[key];
        }
      }
    }
    
    return config;
  }

  /**
   * 获取配置值
   * @param {object} config - 配置对象
   * @param {string} key - 配置键
   * @param {*} defaultValue - 默认值
   * @returns {*} 配置值
   */
  static getConfigValue(config, key, defaultValue = null) {
    return config[key] !== undefined ? config[key] : defaultValue;
  }
}
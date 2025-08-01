import { SocketProxy } from './proxies/socket.js';
import { FetchProxy } from './proxies/fetch.js';
import { Socks5Proxy } from './proxies/socks5.js';
import { ThirdPartyProxy } from './proxies/third-party.js';
import { CloudProviderProxy } from './proxies/cloud-provider.js';
import { DoHProxy } from './proxies/doh.js';
import { DoTProxy } from './proxies/dot.js';

/**
 * 代理工厂类
 * 根据配置创建相应的代理实例
 */
export class ProxyFactory {
  /**
   * 创建代理实例
   * @param {object} config - 配置对象
   * @returns {BaseProxy} 代理实例
   */
  static createProxy(config) {
    const strategy = config.PROXY_STRATEGY || 'socket';
    
    switch (strategy.toLowerCase()) {
      case 'socket':
        return new SocketProxy(config);
      case 'fetch':
        return new FetchProxy(config);
      case 'socks5':
        return new Socks5Proxy(config);
      case 'thirdparty':
        return new ThirdPartyProxy(config);
      case 'cloudprovider':
        return new CloudProviderProxy(config);
      case 'doh':
        return new DoHProxy(config);
      case 'dot':
        return new DoTProxy(config);
      default:
        // 默认Socket代理
        return new SocketProxy(config);
    }
  }
}
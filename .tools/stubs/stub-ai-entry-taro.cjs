// aiQuota 相关模块间接 requires Taro；门禁里只用到纯判定，给最小桩
module.exports = {
  getStorageSync: () => '',
  setStorageSync: () => undefined,
  getStorageSyncSync: () => ''
};

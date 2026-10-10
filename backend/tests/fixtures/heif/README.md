# HEIF 回归样本

`example.heic` 来自 libheif 官方仓库的测试/示例文件：
https://github.com/strukturag/libheif/blob/master/examples/example.heic

尺寸为 1280 × 854，包含两张图片。测试使用主图，验证实际 HEVC 解码，避免只模拟转码器而漏掉部署时缺少解码能力的问题。

上游仓库许可证：LGPL-3.0，见 https://github.com/strukturag/libheif/blob/master/COPYING。

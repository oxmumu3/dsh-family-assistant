# Third-party components and protocol references

This package is an independent community plugin for DeepSeek Harness. It is not an official DeepSeek or Tencent product.

- DeepSeek Harness / Cordis: host peer APIs, MIT, DeepSeek-AI. Runtime model calls use the host's configured provider; this package contains no account keys.
- qrcode 1.5.4: MIT, Copyright (c) 2012 Ryan Day. Used to generate QR SVG locally. Its dependency distribution includes the upstream license; see `node_modules/qrcode/license` after installation.
- PptxGenJS 4.0.1: MIT, https://github.com/gitbrent/PptxGenJS . Produces editable presentations. The package bundles this dependency and its distribution licenses; the transitive image-size dependency is pinned to 2.0.4 in the bundled tree. This workflow creates text slides and does not accept arbitrary image inputs.
- fflate 0.8.3: MIT, https://github.com/101arrowz/fflate . Used for bounded archive checks of presentation and document materials. Its license is included in the dependency distribution.
- Weixin protocol references: Tencent `@tencent-weixin/openclaw-weixin` 2.4.10, MIT, https://github.com/Tencent/openclaw-weixin . The QR, token, polling and sending wire shapes were checked against the published package source. This project implements its own small transport, without embedding OpenClaw or its plugin source.
- Additional protocol cross-check: pan17/dsh-wechat and wechat-opencode (MIT). No single-user bridge runtime or private state is included.

All test identities and tokens are synthetic. The package does not include the author's family records, WeChat credentials, or existing assistant configuration.

## Official voice input integration

Voice preparation and recognition reuse the installed official DeepSeek Harness speech service and SenseVoice provider. Model files are downloaded and verified by that provider; neither models nor audio are included in this plugin package. The small PCM WAV encoding and browser recording lifecycle adapt concepts and portions of `packages/experimental/client-ui-voice-input/src/client/audio.ts` from DeepSeek Harness 0.2.1-rc.2, MIT, Copyright (c) 2026 DeepSeek.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

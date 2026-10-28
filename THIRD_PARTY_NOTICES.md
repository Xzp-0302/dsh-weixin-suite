# Third-party notices

The iLink wire protocol, CDN flow, AES key encoding, QR login states, and message shapes in this project are derived from the public Tencent/openclaw-weixin client implementation at commit `874637a0dbc24050f72d1385add4fc6170a2d726` (version 2.4.10). The adaptation is independently integrated with DeepSeek Harness and does not include the OpenClaw runtime.

Upstream: https://github.com/Tencent/openclaw-weixin

Copyright (C) 2026 Tencent. All rights reserved.

openclaw-weixin is licensed under the MIT.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

DeepSeek Harness API usage references the public MIT-licensed source at commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (0.2.1-rc.3). No Harness implementation is bundled. Runtime packages are supplied by the user's Harness host.

`qrcode` (1.5.4), `qrcode-terminal` (0.12.0) and optional `silk-wasm` (3.7.1) are separate npm dependencies. Preserve their licenses when redistributing their code or bundled artifacts. FFmpeg, when configured, is an external user installation and is not distributed by this project.

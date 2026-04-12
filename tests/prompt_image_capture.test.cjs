const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadPromptImageCaptureModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-prompt-image-capture-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'extension'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/prompt_image_tool_shared.js'),
    path.join(tempDir, 'src', 'agent_tools', 'prompt_image_tool_shared.js')
  );
  // 这里复制最小依赖集到临时 ESM 沙箱，避免直接受仓库 CommonJS 测试环境影响。
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/webpage_screenshot_tool.js'),
    path.join(tempDir, 'src', 'agent_tools', 'webpage_screenshot_tool.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/extension/prompt_image_capture.js'),
    path.join(tempDir, 'src', 'extension', 'prompt_image_capture.js')
  );
  return import(`${pathToFileURL(path.join(tempDir, 'src', 'extension', 'prompt_image_capture.js')).href}?test=${Date.now()}`);
}

function installPromptImageRuntime(options = {}) {
  const records = {
    fetchCalls: [],
    createImageBitmapCalls: [],
    convertCalls: [],
    drawCalls: [],
    bitmapClosed: false
  };

  const sourceMimeType = options.sourceMimeType || 'image/png';
  const bitmapWidth = options.bitmapWidth || 1600;
  const bitmapHeight = options.bitmapHeight || 900;
  const sourceBytes = Buffer.from(options.sourceBytes || 'source-image', 'utf8');
  const outputMimeType = Object.prototype.hasOwnProperty.call(options, 'outputMimeType')
    ? options.outputMimeType
    : 'image/jpeg';
  const outputBytes = Buffer.from(options.outputBytes || 'jpeg-output', 'utf8');

  const previousGlobals = {
    fetch: global.fetch,
    createImageBitmap: global.createImageBitmap,
    OffscreenCanvas: global.OffscreenCanvas
  };

  // 这组 stub 只覆盖截图转码真正依赖的浏览器原语，确保测试聚焦在 MIME/尺寸合同。
  global.fetch = async (input) => {
    records.fetchCalls.push(input);
    return {
      ok: true,
      async blob() {
        return {
          type: sourceMimeType,
          async arrayBuffer() {
            return sourceBytes.buffer.slice(
              sourceBytes.byteOffset,
              sourceBytes.byteOffset + sourceBytes.byteLength
            );
          }
        };
      }
    };
  };

  global.createImageBitmap = async (blob) => {
    records.createImageBitmapCalls.push(blob);
    return {
      width: bitmapWidth,
      height: bitmapHeight,
      close() {
        records.bitmapClosed = true;
      }
    };
  };

  global.OffscreenCanvas = class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext(kind, contextOptions) {
      records.contextRequest = { kind, contextOptions };
      return {
        clearRect: (...args) => {
          records.clearRectArgs = args;
        },
        drawImage: (...args) => {
          records.drawCalls.push(args);
        }
      };
    }

    async convertToBlob(convertOptions) {
      records.convertCalls.push({
        width: this.width,
        height: this.height,
        options: convertOptions
      });
      return {
        type: outputMimeType,
        size: outputBytes.length,
        async arrayBuffer() {
          return outputBytes.buffer.slice(
            outputBytes.byteOffset,
            outputBytes.byteOffset + outputBytes.byteLength
          );
        }
      };
    }
  };

  return {
    records,
    restore() {
      global.fetch = previousGlobals.fetch;
      global.createImageBitmap = previousGlobals.createImageBitmap;
      global.OffscreenCanvas = previousGlobals.OffscreenCanvas;
    }
  };
}

test('buildPromptImageResultFromScreenshotDataUrl 在 original 模式下也统一输出 JPEG', async () => {
  const { buildPromptImageResultFromScreenshotDataUrl } = await loadPromptImageCaptureModule();
  const runtime = installPromptImageRuntime({
    sourceMimeType: 'image/png',
    bitmapWidth: 1920,
    bitmapHeight: 1080,
    outputBytes: 'original-jpeg'
  });

  try {
    const result = await buildPromptImageResultFromScreenshotDataUrl({
      dataUrl: 'data:image/png;base64,QUJDRA==',
      detail: 'original',
      jpegQuality: 0.9
    });

    assert.equal(runtime.records.fetchCalls.length, 1);
    assert.equal(runtime.records.createImageBitmapCalls.length, 1);
    assert.equal(runtime.records.convertCalls.length, 1);
    assert.deepEqual(runtime.records.convertCalls[0], {
      width: 1920,
      height: 1080,
      options: {
        type: 'image/jpeg',
        quality: 0.9
      }
    });
    assert.equal(runtime.records.bitmapClosed, true);

    assert.equal(result.detail, 'original');
    assert.equal(result.mime_type, 'image/jpeg');
    assert.equal(result.original_mime_type, 'image/png');
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.equal(result.original_width, 1920);
    assert.equal(result.original_height, 1080);
    assert.equal(result.resized, false);
    assert.equal(result.approximate_bytes, Buffer.byteLength('original-jpeg'));
    assert.match(result.image_url, /^data:image\/jpeg;base64,/);
  } finally {
    runtime.restore();
  }
});

test('buildPromptImageResultFromScreenshotDataUrl 默认模式会缩放并继续输出 JPEG', async () => {
  const { buildPromptImageResultFromScreenshotDataUrl } = await loadPromptImageCaptureModule();
  const runtime = installPromptImageRuntime({
    sourceMimeType: 'image/png',
    bitmapWidth: 4096,
    bitmapHeight: 2048,
    outputMimeType: '',
    outputBytes: 'default-jpeg'
  });

  try {
    const result = await buildPromptImageResultFromScreenshotDataUrl({
      dataUrl: 'data:image/png;base64,QUJDRA==',
      jpegQuality: 5
    });

    assert.equal(runtime.records.convertCalls.length, 1);
    assert.deepEqual(runtime.records.convertCalls[0], {
      width: 1536,
      height: 768,
      options: {
        type: 'image/jpeg',
        quality: 1
      }
    });

    assert.equal(result.detail, null);
    assert.equal(result.mime_type, 'image/jpeg');
    assert.equal(result.original_mime_type, 'image/png');
    assert.equal(result.width, 1536);
    assert.equal(result.height, 768);
    assert.equal(result.original_width, 4096);
    assert.equal(result.original_height, 2048);
    assert.equal(result.resized, true);
    assert.equal(result.approximate_bytes, Buffer.byteLength('default-jpeg'));
    assert.match(result.image_url, /^data:image\/jpeg;base64,/);
  } finally {
    runtime.restore();
  }
});

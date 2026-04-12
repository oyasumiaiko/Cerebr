const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadPromptImageSourceModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-prompt-image-source-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'extension'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/extension/prompt_image_source.js'),
    path.join(tempDir, 'src', 'extension', 'prompt_image_source.js')
  );
  return import(`${pathToFileURL(path.join(tempDir, 'src', 'extension', 'prompt_image_source.js')).href}?test=${Date.now()}`);
}

function installPromptImageSourceRuntime(options = {}) {
  const previousFetch = global.fetch;
  const previousChrome = global.chrome;
  const records = {
    fetchCalls: [],
    storageKeys: []
  };

  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          records.storageKeys.push(keys);
          return {
            image_download_root: options.imageDownloadRoot || 'C:\\Users\\wintermute\\Documents\\repos\\Cerebr'
          };
        }
      }
    }
  };

  global.fetch = async (url) => {
    records.fetchCalls.push(url);
    return {
      ok: true,
      async blob() {
        return {
          size: 8,
          type: options.blobType || 'image/png',
          async arrayBuffer() {
            return new Uint8Array([1, 2, 3, 4]).buffer;
          }
        };
      }
    };
  };

  return {
    records,
    restore() {
      global.fetch = previousFetch;
      global.chrome = previousChrome;
    }
  };
}

test('resolvePromptImageSourceUrl 支持 http URL、Windows 绝对路径与 Images 相对路径', async () => {
  const {
    resolvePromptImageSourceUrl
  } = await loadPromptImageSourceModule();
  const runtime = installPromptImageSourceRuntime();

  try {
    assert.equal(
      await resolvePromptImageSourceUrl('https://example.com/demo.png'),
      'https://example.com/demo.png'
    );
    assert.equal(
      await resolvePromptImageSourceUrl('C:\\Temp Folder\\demo image.png'),
      'file:///C:/Temp%20Folder/demo%20image.png'
    );
    assert.equal(
      await resolvePromptImageSourceUrl('Images/demo.png'),
      'file:///C:/Users/wintermute/Documents/repos/Cerebr/Images/demo.png'
    );
    assert.equal(runtime.records.storageKeys.length > 0, true);
  } finally {
    runtime.restore();
  }
});

test('fetchPromptImageSourceBlob 直接读取远程图片并拒绝非图片 MIME', async () => {
  const {
    fetchPromptImageSourceBlob
  } = await loadPromptImageSourceModule();
  const runtime = installPromptImageSourceRuntime({
    blobType: 'image/webp'
  });

  try {
    const result = await fetchPromptImageSourceBlob('https://example.com/demo.webp');
    assert.equal(runtime.records.fetchCalls[0], 'https://example.com/demo.webp');
    assert.equal(result.sourceUrl, 'https://example.com/demo.webp');
    assert.equal(result.originalMimeType, 'image/webp');
    assert.equal(result.sourceBlob.size, 8);
  } finally {
    runtime.restore();
  }

  const errorRuntime = installPromptImageSourceRuntime({
    blobType: 'text/html'
  });
  try {
    await assert.rejects(
      () => fetchPromptImageSourceBlob('https://example.com/not-image'),
      /目标资源不是图片/
    );
  } finally {
    errorRuntime.restore();
  }
});

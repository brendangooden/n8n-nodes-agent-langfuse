// Runs against the compiled output: `npm run build` first (npm test does both).
//
// Pins the binary passthrough to n8n's rules: images behind their option, PDFs
// behind theirs, text files always, everything else dropped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  isTextFile,
  isImageFile,
  isPdfFile,
  shouldPassthroughBinary,
  extractBinaryMessages,
} = require('../dist/nodes/AgentLangfuse/binaryPassthrough');

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

/** A minimal IExecuteFunctions: enough for the attachments under test. */
function fakeCtx(binary) {
  return {
    getInputData: () => [{ binary }],
    getNode: () => ({ name: 'AI Agent + Langfuse' }),
    helpers: {
      getBinaryStream: async (id) => Readable.from([Buffer.from(`stream:${id}`, 'utf-8')]),
      binaryToBuffer: async (stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
      },
    },
  };
}

const extract = async (binary, options) =>
  (await extractBinaryMessages(fakeCtx(binary), 0, options)).content;

// --------------------------------------------------------------------------
// The predicates
// --------------------------------------------------------------------------

test('classifies mime types the way n8n does', () => {
  assert.ok(isImageFile('image/png'));
  assert.ok(isPdfFile('application/pdf'));
  for (const mime of ['text/plain', 'application/json', 'application/xml',
    'application/csv', 'application/x-yaml', 'application/yaml']) {
    assert.ok(isTextFile(mime), mime);
  }
  assert.ok(!isTextFile('application/zip'));
  assert.ok(!isImageFile('application/pdf'));
});

test('gates images and PDFs on their own option, and never gates text', () => {
  const img = { mimeType: 'image/png' };
  const pdf = { mimeType: 'application/pdf' };
  const txt = { mimeType: 'text/plain' };
  const zip = { mimeType: 'application/zip' };

  assert.ok(shouldPassthroughBinary(img, { passthroughBinaryImages: true }));
  assert.ok(!shouldPassthroughBinary(img, { passthroughBinaryImages: false }));
  assert.ok(shouldPassthroughBinary(pdf, { passthroughBinaryPdfs: true }));
  assert.ok(!shouldPassthroughBinary(pdf, { passthroughBinaryImages: true }));
  assert.ok(shouldPassthroughBinary(txt, {}));
  assert.ok(!shouldPassthroughBinary(zip, { passthroughBinaryImages: true, passthroughBinaryPdfs: true }));
});

// --------------------------------------------------------------------------
// extractBinaryMessages
// --------------------------------------------------------------------------

test('passes a PDF through as a base64 file block', async () => {
  const content = await extract(
    { doc: { mimeType: 'application/pdf', data: b64('%PDF-1.4'), fileName: 'paper.pdf' } },
    { passthroughBinaryPdfs: true },
  );
  assert.deepEqual(content, [{
    type: 'file',
    source_type: 'base64',
    mime_type: 'application/pdf',
    data: b64('%PDF-1.4'),
    metadata: { filename: 'paper.pdf' },
  }]);
});

test('drops a PDF when its option is off', async () => {
  const content = await extract(
    { doc: { mimeType: 'application/pdf', data: b64('%PDF-1.4'), fileName: 'paper.pdf' } },
    { passthroughBinaryImages: true },
  );
  assert.deepEqual(content, []);
});

test('names an unnamed PDF attachment.pdf', async () => {
  const content = await extract(
    { doc: { mimeType: 'application/pdf', data: b64('x') } },
    { passthroughBinaryPdfs: true },
  );
  assert.equal(content[0].metadata.filename, 'attachment.pdf');
});

test('passes a text file through as a labelled text block', async () => {
  const content = await extract(
    { note: { mimeType: 'text/plain', data: b64('hello there'), fileName: 'notes.txt' } },
    {},
  );
  assert.deepEqual(content, [{ type: 'text', text: 'File: notes.txt\nContent:\nhello there' }]);
});

test('passes JSON through as text', async () => {
  const content = await extract(
    { cfg: { mimeType: 'application/json', data: b64('{"a":1}'), fileName: 'cfg.json' } },
    {},
  );
  assert.equal(content[0].text, 'File: cfg.json\nContent:\n{"a":1}');
});

test('drops a mime type nobody handles', async () => {
  const content = await extract(
    { z: { mimeType: 'application/zip', data: b64('PK') } },
    { passthroughBinaryImages: true, passthroughBinaryPdfs: true },
  );
  assert.deepEqual(content, []);
});

test('normalises an image that already carries a data URL prefix', async () => {
  const content = await extract(
    { img: { mimeType: 'image/png', data: `data:image/png;base64,${b64('PNG')}` } },
    { passthroughBinaryImages: true },
  );
  assert.deepEqual(content, [{
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${b64('PNG')}` },
  }]);
});

test('reads an attachment held in the binary store by id', async () => {
  const content = await extract(
    { doc: { mimeType: 'application/pdf', id: 'abc', data: '', fileName: 'p.pdf' } },
    { passthroughBinaryPdfs: true },
  );
  assert.equal(content[0].data, Buffer.from('stream:abc', 'utf-8').toString('base64'));
});

test('reads a text attachment held in the binary store as utf-8', async () => {
  const content = await extract(
    { note: { mimeType: 'text/plain', id: 'xyz', data: '', fileName: 'n.txt' } },
    {},
  );
  assert.equal(content[0].text, 'File: n.txt\nContent:\nstream:xyz');
});

test('collects images, PDFs and text into one message', async () => {
  const content = await extract(
    {
      img: { mimeType: 'image/png', data: b64('PNG') },
      doc: { mimeType: 'application/pdf', data: b64('PDF'), fileName: 'a.pdf' },
      note: { mimeType: 'text/plain', data: b64('hi'), fileName: 'a.txt' },
      zip: { mimeType: 'application/zip', data: b64('PK') },
    },
    { passthroughBinaryImages: true, passthroughBinaryPdfs: true },
  );
  assert.deepEqual(content.map((c) => c.type), ['image_url', 'file', 'text']);
});

test('refuses an attachment over the 50 MB limit', async () => {
  // 51 MB of decoded bytes, built without allocating the base64 twice.
  const big = 'A'.repeat(Math.ceil((51 * 1024 * 1024) / 3) * 4);
  await assert.rejects(
    () => extract({ doc: { mimeType: 'application/pdf', data: big, fileName: 'huge.pdf' } },
      { passthroughBinaryPdfs: true }),
    /The file "huge.pdf" is 51\.0 MB, which exceeds the 50\.0 MB limit/,
  );
});

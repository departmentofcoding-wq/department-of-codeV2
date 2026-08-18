import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CdpIdeDriver } from '../../engine/harness/cdp-client.ts';

describe('T30: Hand-Rolled CDP Client Integration Test (Stream A1)', () => {
  let tmpDir: string;
  let fixturePath: string;
  let driver: CdpIdeDriver | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t30-'));
    fixturePath = path.join(tmpDir, 'fixture.html');
    fs.writeFileSync(
      fixturePath,
      `<!DOCTYPE html>
      <html>
        <head><title>T30 Fixture</title></head>
        <body>
          <h1 id="title">Hello Harness</h1>
          <input id="input-name" type="text" value="initial" />
          <button id="btn-submit" onclick="document.getElementById('title').innerText = 'Submitted'">Submit</button>
        </body>
      </html>`
    );

    const selectorMap: Record<string, string> = {
      'sel.title': '#title',
      'sel.input': '#input-name',
      'sel.btn': '#btn-submit'
    };

    driver = new CdpIdeDriver(key => {
      const css = selectorMap[key];
      if (!css) throw new Error(`Unknown key ${key}`);
      return css;
    });
  });

  afterEach(async () => {
    if (driver) {
      await driver.close();
      driver = null;
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('launches headless browser, navigates file:// page, reads/acts DOM, and closes cleanly', async () => {
    expect(driver).not.toBeNull();

    // 1. Launch
    await driver!.launch({ headless: true });

    // 2. Navigate file:// URL
    const fileUrl = pathToFileURL(fixturePath).href;
    await driver!.navigate(fileUrl);

    // 3. Read title element
    const readResult = await driver!.read('sel.title');
    expect(readResult.matchCount).toBe(1);
    expect(readResult.text).toBe('Hello Harness');
    expect(readResult.nonceEcho).toMatch(/^[0-9a-f]{32}$/);

    // 4. Act: type text into input
    const actInput = await driver!.act('sel.input', 'type', ' World');
    expect(actInput.success).toBe(true);
    expect(actInput.nonceEcho).toMatch(/^[0-9a-f]{32}$/);

    // 5. Act: click submit button
    const actBtn = await driver!.act('sel.btn', 'click');
    expect(actBtn.success).toBe(true);

    // 6. Read updated title element
    const readUpdated = await driver!.read('sel.title');
    expect(readUpdated.text).toBe('Submitted');

    // 7. Snapshot DOM outline
    const snap = await driver!.snapshot();
    expect(snap.outline).toContain('Submitted');

    // 8. Close driver and assert process/temp dir cleanup
    await driver!.close();
    driver = null;
  }, 15000);
});

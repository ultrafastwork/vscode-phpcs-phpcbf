import assert from 'node:assert';
import sinon from 'sinon';
import { constructCommandString, quoteArg } from '../../utils/helpers';

suite('Argument Quoting Test Suite', () => {
  let platformStub: sinon.SinonStub;

  teardown(() => {
    platformStub.restore();
  });

  test('POSIX: wraps arguments in single quotes', () => {
    platformStub = sinon.stub(process, 'platform').value('linux');
    assert.strictEqual(
      quoteArg('--stdin-path=/a b/c.php'),
      `'--stdin-path=/a b/c.php'`,
    );
  });

  test('POSIX: escapes embedded single quotes', () => {
    platformStub = sinon.stub(process, 'platform').value('linux');
    assert.strictEqual(
      quoteArg(`/tmp/a'; rm -rf ~; '.php`),
      `'/tmp/a'\\''; rm -rf ~; '\\''.php'`,
    );
  });

  test('Windows: wraps arguments in double quotes', () => {
    platformStub = sinon.stub(process, 'platform').value('win32');
    assert.strictEqual(
      quoteArg('--stdin-path=C:\\a b\\c.php'),
      '"--stdin-path=C:\\a b\\c.php"',
    );
  });

  test('Windows: moves % outside the quotes and escapes it', () => {
    platformStub = sinon.stub(process, 'platform').value('win32');
    assert.strictEqual(quoteArg('C:\\%PATH%.php'), '"C:\\"^%"PATH"^%".php"');
  });

  test('constructCommandString quotes the command', () => {
    platformStub = sinon.stub(process, 'platform').value('linux');
    assert.strictEqual(
      constructCommandString(`/opt/it's/phpcs`, [`'-q'`]),
      `'/opt/it'\\''s/phpcs' '-q'`,
    );
  });
});

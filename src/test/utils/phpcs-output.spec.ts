import assert from 'node:assert';
import {
  describeFailureExitCode,
  isCompletedExitCode,
  parsePhpcsJsonReport,
} from '../../utils/phpcs-output';

suite('PHPCS Output Test Suite', () => {
  test('every combination of the 1, 2 and 4 flags is a completed run', () => {
    for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) {
      assert.strictEqual(isCompletedExitCode(code), true, `exit code ${code}`);
    }
  });

  test('processing errors, unmet requirements and unknown codes are failures', () => {
    for (const code of [null, -1, 8, 16, 17, 64, 65, 255]) {
      assert.strictEqual(isCompletedExitCode(code), false, `exit code ${code}`);
    }
  });

  test('failure exit codes are described', () => {
    assert.match(describeFailureExitCode('PHPCS', 16), /processing error/);
    assert.match(describeFailureExitCode('PHPCBF', 64), /Requirements/);
    assert.match(describeFailureExitCode('PHPCBF', 80), /Requirements/);
    assert.match(describeFailureExitCode('PHPCS', 8), /unknown error/);
    assert.match(describeFailureExitCode('PHPCS', null), /terminated/);
  });

  const report = {
    totals: { errors: 1, warnings: 0, fixable: 1 },
    files: {
      STDIN: {
        errors: 1,
        warnings: 0,
        messages: [
          {
            message: 'Missing file doc comment',
            source: 'PEAR.Commenting.FileComment.Missing',
            severity: 5,
            fixable: false,
            type: 'ERROR',
            line: 2,
            column: 1,
          },
        ],
      },
    },
  };

  test('parses a plain JSON report', () => {
    assert.deepStrictEqual(
      parsePhpcsJsonReport(JSON.stringify(report)),
      report,
    );
  });

  test('parses a JSON report preceded by PHP notices', () => {
    const stdout = `\nDeprecated: Something is deprecated in /x.php on line 3\n${JSON.stringify(report)}\n`;
    assert.deepStrictEqual(parsePhpcsJsonReport(stdout), report);
  });

  test('returns null when there is no valid report', () => {
    assert.strictEqual(parsePhpcsJsonReport(''), null);
    assert.strictEqual(
      parsePhpcsJsonReport('ERROR: the "X" standard is not installed.'),
      null,
    );
    assert.strictEqual(parsePhpcsJsonReport('{"totals": {'), null);
  });
});

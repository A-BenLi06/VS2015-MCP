import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { phoneDefinitions, planPhoneDeployment } from '../src/phone.mjs';

test('WP deployment keeps target, package and product identity separate', () => {
  assert.deepEqual(planPhoneDeployment({ platform: 'wp81', action: 'devices' }).arguments, ['/EnumerateDevices']);
  const workingDirectory = path.resolve('packages with spaces');
  const plan = planPhoneDeployment({ platform: 'wp81', action: 'installlaunch', target: '2', package: '手机.appx', workingDirectory });
  assert.deepEqual(plan.arguments, ['/installlaunch', path.join(workingDirectory, '手机.appx'), '/targetdevice:2']);
  assert.throws(() => planPhoneDeployment({ platform: 'wp81', action: 'launch', target: 'de' }), /productId/);
});

test('Mobile deployment requires one explicit target and uses package full names for removal', () => {
  assert.throws(() => planPhoneDeployment({ platform: 'win10m', action: 'list' }), /exactly one/);
  assert.throws(() => planPhoneDeployment({ platform: 'win10m', action: 'list', ip: '127.0.0.1', guid: 'device' }), /exactly one/);
  const plan = planPhoneDeployment({ platform: 'win10m', action: 'uninstall', ip: '192.0.2.1', packageFullName: 'Example_1.0.0.0_x86__publisher' });
  assert.deepEqual(plan.arguments, ['uninstall', '-package', 'Example_1.0.0.0_x86__publisher', '-ip', '192.0.2.1']);
});

test('touch and keyboard schemas require action-specific arguments', () => {
  const schema = phoneDefinitions.find(tool => tool.name === 'phone_input').schema;
  assert.throws(() => schema.parse({ processId: 123, action: 'swipe', x: 1, y: 2 }));
  assert.throws(() => schema.parse({ processId: 123, action: 'tap', x: -1, y: 2 }));
  const parsed = schema.parse({ processId: 123, action: 'text', text: '中文 input' });
  assert.equal(parsed.text, '中文 input');
});

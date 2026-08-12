import assert from 'node:assert/strict';
import { __testing } from '../workers/lib/calendar-drain.js';

assert.equal(__testing.safeLimit(undefined), 10, 'default scheduled drain limit must remain bounded');
assert.equal(__testing.safeLimit(10), 10, 'configured default limit must pass through');
assert.equal(__testing.safeLimit(0), 1, 'drain limit must not fall below one');
assert.equal(__testing.safeLimit(100), 20, 'drain limit must not exceed the hard maximum');
assert.equal(__testing.safeLimit('invalid'), 10, 'invalid limits must fall back to the bounded default');

console.log('Calendar scheduler tests passed: cron drains remain bounded to 1-20 jobs with a default of 10.');

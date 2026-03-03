export const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

export function debugLog(...args: any[]) {
    if (DEBUG) {
        console.debug(...args);
    }
}
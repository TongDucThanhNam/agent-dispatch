// Rows from node:sqlite are read as loosely typed records; the telemetry schemas belong to external tools.
import 'node:sqlite';

declare module 'node:sqlite' {
  interface StatementSync {
    get(...parameters: any[]): any;
    all(...parameters: any[]): any[];
  }
}

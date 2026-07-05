module.exports = {
  collectCoverage: true,
  collectCoverageFrom: [
    "**/src/**/*.ts",
    "!**/node_modules/**",
    "!**/*.d.ts",
    /* The runner runtime executes standalone under fabr test, not under jest */
    "!**/packages/js/src/testRunner/**",
  ],
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.base.json",
    },
  },
  moduleNameMapper: {
    "^@fabr/core$": "<rootDir>/packages/core/src/index.ts",
    "^@fabr/js$": "<rootDir>/packages/js/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  moduleDirectories: ["node_modules"],
  moduleFileExtensions: ["ts", "js"],
  testRegex: ".*\\.test\\.ts$",
  /* The runner runtime's tests are node:test based and run under the fabr
   * test harness itself (fabr test @fabr/js), not under jest */
  testPathIgnorePatterns: ["/node_modules/", "/build/", "/packages/js/src/testRunner/"],
};

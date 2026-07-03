module.exports = {
  collectCoverage: true,
  collectCoverageFrom: ["**/src/**/*.ts", "!**/node_modules/**", "!**/*.d.ts"],
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.base.json",
    },
  },
  moduleNameMapper: {
    "^@fabr/core$": "<rootDir>/packages/core/src/index.ts",
  },
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  moduleDirectories: ["node_modules"],
  moduleFileExtensions: ["ts", "js"],
  testRegex: ".*\\.test\\.ts$",
  testPathIgnorePatterns: ["/node_modules/", "/build/"],
};

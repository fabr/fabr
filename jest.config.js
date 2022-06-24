module.exports = {
  collectCoverage: true,
  collectCoverageFrom: ["**/src/**/*.ts", "!**/node_modules/**", "!**/*.d.ts"],
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.json",
    },
  },
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  moduleDirectories: ["src", "node_modules"],
  moduleFileExtensions: ["ts", "js"],
  testRegex: ".*\\.test\\.ts$"
};

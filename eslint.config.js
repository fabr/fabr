const tslint = require("typescript-eslint");
const eslint = require("@eslint/js");

module.exports = tslint.config(
  eslint.configs.recommended,
  ...tslint.configs.recommended,
  {rules: {
    "@typescript-eslint/no-empty-function": 0,
    "@typescript-eslint/no-this-alias": 0,
    "@typescript-eslint/indent": 0,
    "@typescript-eslint/explicit-function-return-type": ["error", {allowExpressions: true}],
    "@typescript-eslint/no-inferrable-types": 0,
    "@typescript-eslint/no-namespace": 0,
    "@typescript-eslint/no-non-null-assertion": 0,
  }},
);
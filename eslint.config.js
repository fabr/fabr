/*
 * Copyright (c) 2026 Nathan Keynes <nkeynes@deadcoderemoval.net>
 *
 * This file is part of Fabr.
 *
 * Fabr is free software: you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Fabr is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
 * details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Fabr. If not, see <https://www.gnu.org/licenses/>.
 */

const tslint = require("typescript-eslint");
const eslint = require("@eslint/js");

module.exports = tslint.config(
  { ignores: ["**/build/**", "**/node_modules/**", "coverage/**", "test/jest-compat/**/*.js"] },
  eslint.configs.recommended,
  ...tslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-empty-function": 0,
      "@typescript-eslint/no-this-alias": 0,
      "@typescript-eslint/indent": 0,
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/no-inferrable-types": 0,
      "@typescript-eslint/no-namespace": 0,
      "@typescript-eslint/no-non-null-assertion": 0,
      "@typescript-eslint/no-explicit-any": "warn",
      /* A `_`-prefixed parameter is deliberately unused — the convention throughout,
       * used to keep an interface method's signature readable in an implementation
       * that ignores an argument. The default `args: "after-used"` honors it only in
       * non-trailing position, which flags exactly the same intent inconsistently. */
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  /* A `SecureString`'s value is made text where it is used (a request, a
   * process, a key, written content), never pieced into other text, where it
   * would reach a message: build the text with `secure` and take the value of
   * the whole, or show it with `toDisplayString()`. */
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "TemplateLiteral",
          "BinaryExpression[operator='+'] >",
          "NewExpression[callee.name=/Error$/]",
          "CallExpression[callee.property.name='withHelp']",
        ].map(context => ({
          selector: `${context} CallExpression[callee.property.name='toUnmaskedString']`,
          message:
            "Build the text with `secure`: give it to an error or a diagnostic as it is, or take toUnmaskedString() of the whole where the value is used.",
        })),
      ],
    },
  },
  /* Type-aware checks, for the packages with a tsconfig. A `SecureString`, a
   * `Name` and a `Property` are made strings only explicitly (their
   * `toString()` throws or returns a `SecureString`), so making any object a
   * string by a template literal or `+` is an error here. */
  {
    files: ["packages/{core,js,js-tools,cli,sass-pnp-importer}/src/**/*.ts"],
    ignores: ["**/*.d.ts"],
    languageOptions: { parserOptions: { project: ["packages/*/tsconfig.json"], tsconfigRootDir: __dirname } },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true, allowAny: true, allowRegExp: true, allowNever: true },
      ],
      "@typescript-eslint/restrict-plus-operands": ["error", { allowAny: true, allowNumberAndString: true }],
    },
  }
);

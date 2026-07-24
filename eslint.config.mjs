import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';
import prettier from 'eslint-plugin-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

export default defineConfig([
    globalIgnores(['**/out', '**/dist', '**/*.d.ts']),
    {
        extends: compat.extends('plugin:prettier/recommended'),

        plugins: {
            prettier,
        },

        languageOptions: {
            parser: babelParser,
            parserOptions: {
                requireConfigFile: false,
                babelOptions: {
                    presets: ['@babel/preset-typescript'],
                },
            },
            ecmaVersion: 'latest',
            sourceType: 'module',
        },

        rules: {},
    },
]);

import tseslint from "typescript-eslint"

/**
 * 禁止用注释关闭 lint 规则。
 *
 * 规则被关掉就等于没有规则，所以这里直接报错，
 * 需要放宽的地方应该改代码本身。
 */
const noLintDisable = {
  meta: {
    type: "problem",
    docs: { description: "Disallow eslint-disable directives" },
    schema: [],
    messages: { forbidden: "禁止禁用 lint：{{ text }}" },
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of context.sourceCode.getAllComments()) {
          if (/^\s*eslint-disable\b/.test(comment.value)) {
            context.report({
              node,
              messageId: "forbidden",
              data: { text: comment.value.trim() },
            })
          }
        }
      },
    }
  },
}

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "web/**"],
  },
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      local: { rules: { "no-lint-disable": noLintDisable } },
    },
    rules: {
      "local/no-lint-disable": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
)

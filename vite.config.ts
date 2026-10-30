import { defineConfig, type Plugin } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** KaTeX 的每个字体都带 woff2 / woff / ttf 三份，现代浏览器只用 woff2；单文件版里只留它，体积小一半 */
const katexWoff2Only: Plugin = {
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/katex(\.min)?\.css$/.test(id)) return null;
    return code.replace(/,\s*url\([^)]*\.(woff|ttf)\)\s*format\("(woff|truetype)"\)/g, '');
  },
};

// `vite build --mode single`：把脚本、样式、字体、Worker 全部内联进一个 HTML，双击即可离线使用
export default defineConfig(({ mode }) => ({
  base: './',
  worker: { format: 'es' },
  plugins: mode === 'single' ? [katexWoff2Only, viteSingleFile()] : [],
  build: mode === 'single' ? { outDir: 'dist-single' } : {},
  test: { include: ['tests/**/*.test.ts'] },
}));

// @ts-check

import * as path from 'path';
import { readFileByLine } from './lib/fetch-text-by-line';
import { processLine } from './lib/process-line';
import { createRuleset } from './lib/create-file';
import { domainDeduper } from './lib/domain-deduper';
import type { Span } from './trace';
import { task } from './trace';
import { SHARED_DESCRIPTION } from './lib/constants';
import picocolors from 'picocolors';
import { fdir as Fdir } from 'fdir';

const MAGIC_COMMAND_SKIP = '# $ custom_build_script';
const MAGIC_COMMAND_TITLE = '# $ meta_title ';
const MAGIC_COMMAND_DESCRIPTION = '# $ meta_description ';

const sourceDir = path.resolve(import.meta.dir, '../Source');
const outputSurgeDir = path.resolve(import.meta.dir, '../List');
const outputClashDir = path.resolve(import.meta.dir, '../Clash');

export const buildCommon = task(import.meta.main, import.meta.path)(async (span) => {
  const promises: Array<Promise<unknown>> = [];

  const paths = await new Fdir()
    .withRelativePaths()
    .crawl(sourceDir)
    .withPromise();

  for (let i = 0, len = paths.length; i < len; i++) {
    const relativePath = paths[i];

    const extname = path.extname(relativePath);
    if (extname === '.js' || extname === '.ts') {
      continue;
    }
    const fullPath = sourceDir + path.sep + relativePath;

    if (relativePath.startsWith('domainset/')) {
      promises.push(transformDomainset(span, fullPath, relativePath));
      continue;
    }
    if (
      relativePath.startsWith('ip/')
      || relativePath.startsWith('non_ip/')
    ) {
      promises.push(transformRuleset(span, fullPath, relativePath));
      continue;
    }

    console.error(picocolors.red(`[build-comman] Unknown file: ${relativePath}`));
  }

  return Promise.all(promises);
});

const processFile = (span: Span, sourcePath: string) => {
  // console.log('Processing', sourcePath);
  return span.traceChildAsync(`process file: ${sourcePath}`, async () => {
    const lines: string[] = [];

    let title = '';
    const descriptions: string[] = [];

    try {
      for await (const line of readFileByLine(sourcePath)) {
        if (line.startsWith(MAGIC_COMMAND_SKIP)) {
          return null;
        }

        if (line.startsWith(MAGIC_COMMAND_TITLE)) {
          title = line.slice(MAGIC_COMMAND_TITLE.length).trim();
          continue;
        }

        if (line.startsWith(MAGIC_COMMAND_DESCRIPTION)) {
          descriptions.push(line.slice(MAGIC_COMMAND_DESCRIPTION.length).trim());
          continue;
        }

        const l = processLine(line);
        if (l) {
          lines.push(l);
        }
      }
    } catch (e) {
      console.error('Error processing', sourcePath);
      console.trace(e);
    }

    return [title, descriptions, lines] as const;
  });
};

function transformDomainset(parentSpan: Span, sourcePath: string, relativePath: string) {
  return parentSpan
    .traceChildAsync(
      `transform domainset: ${path.basename(sourcePath, path.extname(sourcePath))}`,
      async (span) => {
        const res = await processFile(span, sourcePath);
        if (!res) return;

        const [title, descriptions, lines] = res;

        const deduped = domainDeduper(lines);
        const description = [
          ...SHARED_DESCRIPTION,
          ...(
            descriptions.length
              ? ['', ...descriptions]
              : []
          )
        ];

        return createRuleset(
          span,
          title,
          description,
          new Date(),
          deduped,
          'domainset',
          path.resolve(outputSurgeDir, relativePath),
          path.resolve(outputClashDir, `${relativePath.slice(0, -path.extname(relativePath).length)}.txt`)
        );
      }
    );
}

/**
 * Output Surge RULE-SET and Clash classical text format
 */
async function transformRuleset(parentSpan: Span, sourcePath: string, relativePath: string) {
  return parentSpan
    .traceChild(`transform ruleset: ${path.basename(sourcePath, path.extname(sourcePath))}`)
    .traceAsyncFn(async (span) => {
      const res = await processFile(span, sourcePath);
      if (!res) return null;

      const [title, descriptions, lines] = res;

      const description = [
        ...SHARED_DESCRIPTION,
        ...(
          descriptions.length
            ? ['', ...descriptions]
            : []
        )
      ];

      return createRuleset(
        span,
        title,
        description,
        new Date(),
        lines,
        'ruleset',
        path.resolve(outputSurgeDir, relativePath),
        path.resolve(outputClashDir, `${relativePath.slice(0, -path.extname(relativePath).length)}.txt`)
      );
    });
}

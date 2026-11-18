import { BLOCK_PATH, type Page, type PageBlock, type TabBlock } from './schema.js';

/*
 * Where blocks are on a page (design §6.5). A block is named by its place, as "2"; a block that
 * tabs hold is named by the tabs' place, the tab and its own place, as "2.1.0". Screens ask for
 * the records and the numbers of each block by that path.
 */

/** Each block of a page with its path: the blocks that tabs hold too, but not the tabs themselves. */
export function pageBlocks(page: Pick<Page, 'blocks'>): Array<{ readonly block: TabBlock; readonly path: string }> {
  return page.blocks.flatMap((block, index) =>
    block.type === 'tabs' ? block.tabs.flatMap((tab, t) => tab.blocks.map((inner, i) => ({ block: inner, path: `${index}.${t}.${i}` }))) : [{ block, path: String(index) }],
  );
}

/** The block at a path of a page, if there is one. */
export function blockAt(page: Pick<Page, 'blocks'>, path: string): PageBlock | undefined {
  const match = BLOCK_PATH.exec(path);
  if (!match) return undefined;
  const outer = page.blocks[Number(match[1])];
  if (match[2] === undefined) return outer;
  return outer?.type === 'tabs' ? outer.tabs[Number(match[2])]?.blocks[Number(match[3])] : undefined;
}

/** Where a block is in the definition, as the checks name it: `blocks[2]`, or `blocks[2].tabs[1].blocks[0]`. */
export function blockPlace(path: string): string {
  const match = BLOCK_PATH.exec(path);
  if (!match) return 'blocks';
  return match[2] === undefined ? `blocks[${match[1]}]` : `blocks[${match[1]}].tabs[${match[2]}].blocks[${match[3]}]`;
}

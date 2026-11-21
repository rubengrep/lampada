/* Lampada: punto di ingresso. Il codice è in src/, "npm run build" genera main.js. */
import { LampadaPlugin } from './plugin.js';
import { BibleSettingTab } from './impostazioni.js';
import { jwTokenText, jwlMarker, parseNoteFile, formatNoteBlock, noteFreeText, jwTokenCount, splitJwTokens, refFromCodes, jwLibraryUrl, cleanSnippet, parseChapterMarkdown, parseVerseList, compressVerses, extractBlock } from './testo.js';
import { JwlImporter } from './jwl-importa.js';
import { JwlExporter, zipFiles, crc32, parseJwlBlocks, sameNoteTitle } from './jwl-esporta.js';
import { unzipEntries, buildJwlPlan, jwlTag, formatIssue, jwlNoteBlock } from './jwl-formati.js';
import { BibleData } from './bibbia-dati.js';
import { convertBibleEpub } from './bibbia-epub.js';
import { LibraryData, parseMeetingHtml, weekStartFromLabel } from './biblioteca-dati.js';
import { epubExtras } from './epub-extra.js';
import { convertPubEpub, parseSymbol, refRange } from './biblioteca-epub.js';

export default LampadaPlugin;
// Per le prove automatiche (test/).
import { SourceList, askAboutSources, leadText, parsePresets, splitCited, suggestComments } from './studio.js';
import { BibleView } from './bibbia-vista.js';
import { IndexBuilder, IndexReader, notePars, paragraphsOf, stem, terms } from './ricerca.js';
import { LibrarySearch, askLibrary } from './chat-biblioteca.js';
import { LampadaView } from './guscio.js';
import { LibraryView } from './biblioteca-vista.js';
import { fileAt, fileMeta, fileSrc, folderFiles, linkDest, mdFiles, readFile, scanHidden, subfolders } from './file.js';
export const _test = { epubExtras, LibraryData, parseMeetingHtml, weekStartFromLabel, scanHidden, fileAt, folderFiles, subfolders, mdFiles, readFile, fileMeta, linkDest, fileSrc, LampadaView, IndexBuilder, IndexReader, notePars, paragraphsOf, stem, terms, LibrarySearch, askLibrary, BibleView, LibraryView, SourceList, askAboutSources, splitCited, leadText, parsePresets, suggestComments, BibleSettingTab, jwTokenText, jwlMarker, parseNoteFile, formatNoteBlock, noteFreeText, JwlImporter, JwlExporter, zipFiles, crc32, parseJwlBlocks, sameNoteTitle, jwTokenCount, splitJwTokens, unzipEntries, buildJwlPlan, jwlTag, formatIssue, jwlNoteBlock, refFromCodes, jwLibraryUrl, cleanSnippet, parseChapterMarkdown, parseVerseList, compressVerses, extractBlock, BibleData, convertBibleEpub, convertPubEpub, parseSymbol, refRange };

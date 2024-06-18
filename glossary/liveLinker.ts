import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    DecorationSet,
    EditorView,
    PluginSpec,
    PluginValue,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import { App, getLinkpath, parseFrontMatterAliases, TFile, Vault } from "obsidian";

import IntervalTree from '@flatten-js/interval-tree'
import { GlossaryLinkerPluginSettings } from "main";
import { LinkerCache, PrefixTree } from "./linkerCache";

export class LiveLinkWidget extends WidgetType {

    constructor(public text: string, public linkFile: TFile, public app: App, private settings: GlossaryLinkerPluginSettings) {
        super();
        // console.log(text, linkFile, app)
    }

    createInternalLinkSpan() {
        // if (!this.app) {
        //     return null;
        // }
        const note = this.linkFile;
        // const linkText = note.basename;
        const linkText = this.text;
        let linkHref = "";
        try {
            linkHref = note.path;
        } catch (e) {
            console.error(e)
        }

        const span = document.createElement('span');
        const link = document.createElement('a');

        link.href = linkHref;
        link.textContent = linkText + this.settings.glossarySuffix;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.classList.add('internal-link', 'glossary-entry');

        span.appendChild(link);
        return span;
    }

    toDOM(view: EditorView): HTMLElement {
        const div = this.createInternalLinkSpan();

        return div;
    }
}


class AutoLinkerPlugin implements PluginValue {
    decorations: DecorationSet;
    app: App;
    vault: Vault;
    linkerCache: LinkerCache;

    settings: GlossaryLinkerPluginSettings;

    private lastCursorPos: number = 0;
    private lastActiveFile: string = "";

    constructor(view: EditorView, app: App, settings: GlossaryLinkerPluginSettings) {
        this.app = app;
        this.settings = settings;

        const { vault } = this.app;
        this.vault = vault;

        this.linkerCache = new LinkerCache(app, this.settings);

        this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
        const cursorPos = update.view.state.selection.main.from;
        const activeFile = this.app.workspace.getActiveFile()?.path;
        const fileChanged = activeFile != this.lastActiveFile;

        if (this.lastCursorPos != cursorPos || update.docChanged || fileChanged || update.viewportChanged) {
            this.lastCursorPos = cursorPos;
            this.linkerCache.updateCache();
            this.decorations = this.buildDecorations(update.view);
            this.lastActiveFile = activeFile ?? "";
        }
    }



    destroy() { }

    buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        for (let { from, to } of view.visibleRanges) {

            this.linkerCache.reset();
            const text = view.state.doc.sliceString(from, to);

            // For every glossary file and its aliases we now search the text for occurrences
            const additions: { id: number, from: number, to: number, widget: WidgetType }[] = [];

            let id = 0;
            // Iterate over every char in the text
            for (let i = 0; i <= text.length; i) {
                // Do this to get unicode characters as whole chars and not only half of them
                const codePoint = text.codePointAt(i)!;
                const char = i < text.length ? String.fromCodePoint(codePoint) : "\n";

                // const char = i < text.length ? text[i] : "\n";
                // console.log(char);

                // If we are at a word boundary, get the current fitting files
                if (PrefixTree.checkWordBoundary(char)) {
                    const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(i);
                    if (currentNodes.length > 0) {

                        // TODO: Handle multiple matches
                        const node = currentNodes[0];
                        const nFrom = node.start;
                        const nTo = node.end;
                        const name = text.slice(nFrom, nTo);

                        // TODO: Handle multiple files
                        const file = node.files.values().next().value;

                        additions.push({
                            id: id++,
                            from: from + nFrom,
                            to: from + nTo,
                            widget: new LiveLinkWidget(name, file, this.app, this.settings)
                        });
                    }
                }

                // Push the char to get the next nodes in the prefix tree
                this.linkerCache.cache.pushChar(char);

                i += char.length;
            }

            // Sort additions by from position
            additions.sort((a, b) => {
                if (a.from === b.from) {
                    return b.to - a.to;
                }
                return a.from - b.from
            });

            // Delete additions that overlap
            // Additions are sorted by from position and after that by length, we want to keep longer additions
            const filteredAdditions = [];
            const additionsToDelete: Map<number, boolean> = new Map();
            for (let i = 0; i < additions.length; i++) {
                const addition = additions[i];
                for (let j = i + 1; j < additions.length; j++) {
                    const otherAddition = additions[j];
                    if (otherAddition.from >= addition.to) {
                        break;
                    }

                    additionsToDelete.set(otherAddition.id, true);
                }
            }

            for (const addition of additions) {
                if (!additionsToDelete.has(addition.id)) {
                    filteredAdditions.push(addition);
                }
            }

            // We want to exclude some syntax nodes from being decorated,
            // such as code blocks and manually added links
            const excludedIntervalTree = new IntervalTree();
            const excludedTypes = [
                "codeblock",
                "code-block",
                "internal-link",
            ]

            syntaxTree(view.state).iterate({
                from,
                to,
                enter(node) {
                    const text = view.state.doc.sliceString(node.from, node.to);
                    // console.log(node, node.type.name, node.from, node.to, text)

                    const type = node.type.name;

                    for (const excludedType of excludedTypes) {
                        if (type.contains(excludedType)) {
                            excludedIntervalTree.insert([node.from, node.to]);
                        }
                    }
                },
            });

            const cursorPos = view.state.selection.main.from;

            filteredAdditions.forEach(addition => {
                const [from, to] = [addition.from, addition.to];
                const overlaps = excludedIntervalTree.search([from, to]);
                const cursorNearby = (cursorPos >= from - 0 && cursorPos <= to + 0);

                if (overlaps.length === 0 && !cursorNearby) {
                    builder.add(from, to, Decoration.replace({
                        widget: addition.widget
                    }));
                }
            });
        }

        return builder.finish();
    }
}


const pluginSpec: PluginSpec<AutoLinkerPlugin> = {
    decorations: (value: AutoLinkerPlugin) => value.decorations,
};

export const liveLinkerPlugin = (app: App, settings: GlossaryLinkerPluginSettings) => {
    return ViewPlugin.define((editorView: EditorView) => {
        return (new AutoLinkerPlugin(editorView, app, settings));
    }, pluginSpec)
}


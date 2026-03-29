export interface Persistable {
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
export declare function registerStore(name: string, store: Persistable): void;
export declare function loadAll(): Promise<void>;
export declare function markDirty(): void;
export declare function shutdown(): Promise<void>;
//# sourceMappingURL=persistence.d.ts.map

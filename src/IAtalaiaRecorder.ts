export interface IAtalaiaRecorder {
    notifyMovement(smart?: boolean): void;
    notifyPerson(): void;
    close(): void;
}

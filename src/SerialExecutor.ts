/** Execute the provided async actions one at a time. */
export class SerialExecutor {
    private _executionQueue: (() => Promise<unknown>)[] = [];
    private _rejectionQueue: ((reason?: any) => void)[] = [];

    isEmpty() {
        return this._executionQueue.length === 0;
    }

    clear() {
        for (const rejection of this._rejectionQueue) {
            rejection("Cancelling all pending tasks.");
        }

        // clear arrays
        this._executionQueue.length = 0;
        this._rejectionQueue.length = 0;
    }

    execute<T>(action: () => Promise<T>): Promise<T> {
        // ensure everything is done serially
        return new Promise<T>((resolve, reject) => {
            const execution = async () => {
                try {
                    resolve(await action());
                } catch (err) {
                    reject(err);
                } finally {
                    this._executionQueue.shift(); // remove this action from the queue
                    this._rejectionQueue.shift();

                    if (this._executionQueue.length > 0) {
                        this._executionQueue[0](); // start the next action
                    }
                }
            };

            this._executionQueue.push(execution);
            this._rejectionQueue.push(reject);

            if (this._executionQueue.length === 1) {
                execution();
            }
        });
    }
}

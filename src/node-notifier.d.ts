declare module 'node-notifier' {
  interface NotificationOptions {
    title?: string;
    message?: string;
    sound?: boolean;
    wait?: boolean;
    icon?: string;
  }
  interface NodeNotifier {
    notify(options: NotificationOptions, callback?: (err: Error | null, response: string) => void): void;
  }
  const notifier: NodeNotifier;
  export default notifier;
}

import { join } from "path";
import {
  window,
  workspace,
  ExtensionContext,
  ViewColumn,
  WebviewPanel,
  Uri,
  ProgressLocation,
  DecorationOptions,
  commands,
  QuickPickItem
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from "vscode-languageclient";
import StatusBar from "./statusBar";

const { version, referenceID } = require("../package.json");

export function activate(context: ExtensionContext) {
  const serverModule = context.asAbsolutePath(
    join("node_modules/apollo-language-server/lib", "server.js")
  );

  const env = {
    APOLLO_CLIENT_NAME: "Apollo VS Code",
    APOLLO_CLIENT_VERSION: version,
    APOLLO_CLIENT_REFERENCE_ID: referenceID
  };

  const debugOptions = {
    execArgv: ["--nolazy", "--inspect=6009"],
    env
  };
  let schemaTagItems: QuickPickItem[] = [];

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };

  const outputChannel = window.createOutputChannel("Apollo GraphQL");

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      "graphql",
      "javascript",
      "typescript",
      "javascriptreact",
      "typescriptreact",
      "python"
    ],
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher("**/apollo.config.js"),
        workspace.createFileSystemWatcher("**/package.json"),
        workspace.createFileSystemWatcher("**/*.{graphql,js,ts,jsx,tsx,py}")
      ]
    },
    outputChannel
  };

  const client = new LanguageClient(
    "apollographql",
    "Apollo GraphQL",
    serverOptions,
    clientOptions
  );
  const statusBar = new StatusBar(context, client);

  client.registerProposedFeatures();
  context.subscriptions.push(client.start());

  client.onReady().then(() => {
    commands.registerCommand("apollographql/showStatus", () => {
      client.sendNotification("apollographql/getStatus");
    });

    client.onNotification("apollographql/statusLoaded", params => {
      const timeSince = (date: number) => {
        const seconds = Math.floor((+new Date() - date) / 1000);
        let interval = Math.floor(seconds / 86400);
        if (interval >= 1) return `${interval}d`;

        interval = Math.floor(seconds / 3600);
        if (interval >= 1) return `${interval}h`;

        interval = Math.floor(seconds / 60);
        if (interval >= 1) return `${interval}m`;

        return `${Math.floor(seconds)}s`;
      };

      if (!params.loaded) {
        client.outputChannel.appendLine(
          "Service not loaded. See above errors if any are printed"
        );
      } else {
        client.outputChannel.appendLine("------------------------------");
        client.outputChannel.appendLine(`🚀 Apollo GraphQL v${version}`);
        client.outputChannel.appendLine("✅ Service Loaded!");
        client.outputChannel.appendLine(`🆔 Service ID: ${params.serviceId}`);
        client.outputChannel.appendLine(`🏷 Schema Tag: ${params.tag}`);
        client.outputChannel.appendLine(
          `📈 Number of Types: ${params.types.total} ${
            params.types.client
              ? `(${params.types.client} client ${
                  params.types.client > 1 ? "types" : "type"
                })`
              : ""
          }`
        );
        client.outputChannel.appendLine(
          `🗓 Last Fetched ${timeSince(params.lastFetch)} Ago`
        );
        client.outputChannel.appendLine("------------------------------");
      }
      client.outputChannel.show();
    });

    commands.registerCommand("apollographql/reloadService", () => {
      // wipe out tags when reloading
      // XXX we should clean up this handling
      schemaTagItems = [];
      client.sendNotification("apollographql/reloadService");
    });

    // For some reason, non-strings can only be sent in one direction. For now, messages
    // coming from the language server just need to be stringified and parsed.
    client.onNotification("apollographql/tagsLoaded", params => {
      const [serviceID, tags]: [string, string[]] = JSON.parse(params);
      const items = tags.map(tag => ({
        label: tag,
        description: "",
        detail: serviceID
      }));

      schemaTagItems = [...items, ...schemaTagItems];
    });

    commands.registerCommand("apollographql/selectSchemaTag", async () => {
      const selection = await window.showQuickPick(schemaTagItems);
      if (selection) {
        client.sendNotification("apollographql/tagSelected", selection);
      }
    });

    let currentLoadingResolve: Map<number, () => void> = new Map();

    client.onNotification("apollographql/loadingComplete", token => {
      statusBar.showLoadedState();
      const inMap = currentLoadingResolve.get(token);
      if (inMap) {
        inMap();
        currentLoadingResolve.delete(token);
      }
    });

    client.onNotification("apollographql/loading", ({ message, token }) => {
      window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: message,
          cancellable: false
        },
        () => {
          return new Promise(resolve => {
            currentLoadingResolve.set(token, resolve);
          });
        }
      );
    });

    const engineDecoration = window.createTextEditorDecorationType({});
    let latestDecs: any[] | undefined = undefined;

    const updateDecorations = () => {
      if (window.activeTextEditor && latestDecs) {
        const editor = window.activeTextEditor!;
        const decorations: DecorationOptions[] = latestDecs
          .filter(
            d => d.document === window.activeTextEditor!.document.uri.toString()
          )
          .map(dec => {
            return {
              range: editor.document.lineAt(dec.range.start.line).range,
              renderOptions: {
                after: {
                  contentText: `${dec.message}`,
                  textDecoration: "none; padding-left: 15px; opacity: .5"
                }
              }
            };
          });

        window.activeTextEditor!.setDecorations(engineDecoration, decorations);
      }
    };

    client.onNotification("apollographql/engineDecorations", (...decs) => {
      latestDecs = decs;
      updateDecorations();
    });

    window.onDidChangeActiveTextEditor(() => {
      updateDecorations();
    });

    workspace.registerTextDocumentContentProvider("graphql-schema", {
      provideTextDocumentContent(uri: Uri) {
        // the schema source is provided inside the URI, just return that here
        return uri.query;
      }
    });
  });
}

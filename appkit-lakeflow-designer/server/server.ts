import { createApp, server } from '@databricks/appkit';
import { designer } from '@databricks/appkit/beta';

await createApp({ plugins: [server(), designer()] });

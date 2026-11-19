import { createFileRoute } from '@tanstack/react-router';

import { LondonMapsPage } from './maps';

function Homepage() {
    return <LondonMapsPage showHomepageComparison />;
}

export const Route = createFileRoute('/')({ component: Homepage });

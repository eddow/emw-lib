Unlike standard HTML scrapers that crawl markup tags, querying the **BODACC** (Bulletin officiel des annonces civiles et commerciales) acts more like an automated database subscriber. It runs against the French government's OpenDataSoft REST API endpoint (`bodacc-datadila.opendatasoft.com`).

Below is the technical specification, query syntax, and a production-ready TypeScript implementation to ingest fresh business triggers straight into your app.

---

### 1. TypeScript Specification (`bodacc-types.ts`)

```typescript
export type BodaccCategory = 
  | 'Créations' 
  | 'Modifications diverses' 
  | 'Procédures collectives' 
  | 'Dépôts des comptes' 
  | 'Ventes et cessions';

export interface BodaccQueryOptions {
  category?: BodaccCategory;     // e.g., 'Créations'
  department?: string;           // e.g., '75', '69', '33'
  dateFrom?: string;             // Format: 'YYYY-MM-DD'
  limit?: number;                // Max records to fetch (default: 20, max per request usually 100)
  offset?: number;               // Pagination offset
}

export interface BodaccRecord {
  id: string;                    // Unique announcement record ID
  parution: string;              // Publication date (YYYY-MM-DD)
  familleavis: string;           // Category name
  annonce: {
    registre: {
      numeroidentification: string; // The precious SIREN (9 digits)
      rcs: string;                 // City registry (e.g., 'RCS Lyon')
    };
    personne morale?: {
      denomination: string;        // Company legal name
      enseigne?: string;           // Trading brand name
      formeJuridique?: string;     // e.g., 'SAS', 'SARL'
      administration?: Array<{     // Directors / Managers
        nom: string;
        prenom: string;
        qualite: string;           // e.g., 'Président', 'Gérant'
      }>;
    };
    // Note: depending on the category, individual persona or asset data may appear here
    administration?: Array<any>;
    contenu?: string;              // Raw text description of the legal change
  };
  // Geographical breakdown field provided by API
  departement: string;
  region?: string;
  ville?: string;
}

export interface BodaccApiResponse {
  total_count: number;
  results: BodaccRecord[];
}

```

---

### 2. Implementation Script (`bodacc-client.ts`)

This utilizes the official ODSQL (OpenDataSoft Query Language) parameters via standard fetch. **No API key or user authentication is required.**

```typescript
import type { BodaccQueryOptions, BodaccApiResponse, BodaccRecord } from './bodacc-types';

const BODACC_API_URL = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

export async function fetchBodaccLeads(options: BodaccQueryOptions = {}): Promise<BodaccRecord[]> {
  const {
    category = 'Créations',
    department,
    dateFrom,
    limit = 20,
    offset = 0
  } = options;

  // Build ODSQL filter parameters (where clause)
  const conditions: string[] = [];

  if (category) {
    conditions.push(`familleavis = "${category}"`);
  }
  if (department) {
    conditions.push(`departement = "${department}"`);
  }
  if (dateFrom) {
    conditions.push(`dateparution >= "${dateFrom}"`);
  }

  const whereClause = conditions.join(' AND ');

  // Construct query parameters
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
    order_by: 'dateparution DESC',
  });

  if (whereClause) {
    params.append('where', whereClause);
  }

  const targetUrl = `${BODACC_API_URL}?${params.toString()}`;

  try {
    const response = await fetch(targetUrl);
    
    if (!response.ok) {
      throw new Error(`BODACC API error: ${response.status} ${response.statusText}`);
    }

    const data: BodaccApiResponse = await response.json();
    return data.results;
  } catch (error) {
    console.error('Failed to fetch from BODACC API:', error);
    throw error;
  }
}

// --- EXAMPLE USAGE ---
async function runExample() {
  console.log('Fetching fresh business creations in Rhône (69) for the current week...');
  
  const recentCreations = await fetchBodaccLeads({
    category: 'Créations',
    department: '69',
    dateFrom: '2026-09-01',
    limit: 5
  });

  for (const record of recentCreations) {
    const siren = record.annonce?.registre?.numeroidentification ?? 'N/A';
    const name = record.annonce?.['personne morale']?.denomination ?? 'Unknown Entity';
    const city = record.ville ?? 'Unknown City';

    console.log(`- [SIREN: ${siren}] ${name} located in ${city} (Published: ${record.parution})`);
  }
}

```

---

### 3. How to Connect This Directly to Your App Pipeline

Because the BODACC payload gives you the **SIREN number** and company name immediately, you can chain it directly into your core infrastructure:

1. **The Cron Trigger:** Run a script every morning targeting yesterday’s date (`dateFrom = 'YESTERDAY'`).
2. **The SIREN Bridge:** Pass the extracted `numeroidentification` (SIREN) directly into the French government's company registry directory or an enrichment API to pull their exact mailing address, official NAF sector code, and director metadata.
3. **The Web Search Match:** Feed the company name + city into your general website scraper to find their actual domain URL (e.g., matching *“Menuiserie Dupont”* to `menuiserie-dupont.fr`).
4. **App Integration:** Push that complete unified profile into your app's `preview` line as a hot, intent-driven lead ready for automated outreach or dashboard mockup generation.
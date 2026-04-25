
export interface WeatherData {
  temperature: number;
  humidity: number;
  condition: string;
  location: string;
  rainfall?: number;
}

export interface CropSuggestion {
  name: string;
  suitabilityScore: number;
  reasoning: string;
  estimatedYield: string;
  plantingSeason: string;
}

export interface TranscriptionItem {
  type: 'user' | 'ai';
  text: string;
}

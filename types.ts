
export type ZodiacSign = 'Aries' | 'Tauro' | 'Géminis' | 'Cáncer' | 'Leo' | 'Virgo' | 'Libra' | 'Escorpio' | 'Sagitario' | 'Capricornio' | 'Acuario' | 'Piscis';

export interface UserData {
  name: string;
  height: number;
  zodiac: ZodiacSign;
}

export interface PoseAngle {
  name: string;
  angle: number;
}

export interface SavedPoseData {
  id: string;
  concept: string;
  angles: PoseAngle[];
  image: string;
  haiku: string;
  createdAt: string;
}

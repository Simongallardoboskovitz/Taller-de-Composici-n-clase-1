
import React, { useState } from 'react';
import type { UserData, ZodiacSign } from '../types';

interface UserSetupModalProps {
  onSubmit: (data: UserData) => void;
  zodiacSigns: ZodiacSign[];
}

const UserSetupModal: React.FC<UserSetupModalProps> = ({ onSubmit, zodiacSigns }) => {
  const [name, setName] = useState('');
  const [height, setHeight] = useState('');
  const [zodiac, setZodiac] = useState<ZodiacSign | ''>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name && height && zodiac) {
      onSubmit({
        name,
        height: parseInt(height, 10),
        zodiac,
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
      <div className="bg-black border border-white p-8 shadow-2xl text-center w-11/12 max-w-md rounded-lg">
        <h2 className="text-2xl font-bold text-white mb-4">Bienvenido/a</h2>
        <p className="text-gray-400 mb-6">Por favor, completa tus datos para comenzar.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tu Nombre"
            className="w-full bg-gray-800 text-white p-3 border border-gray-600 rounded-md"
            required
          />
          <input
            type="number"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            placeholder="Tu Altura (cm)"
            className="w-full bg-gray-800 text-white p-3 border border-gray-600 rounded-md"
            required
          />
          <select
            value={zodiac}
            onChange={(e) => setZodiac(e.target.value as ZodiacSign)}
            className="w-full bg-gray-800 text-white p-3 border border-gray-600 rounded-md"
            required
          >
            <option value="">Tu Signo Zodiacal...</option>
            {zodiacSigns.map((sign) => (
              <option key={sign} value={sign}>{sign}</option>
            ))}
          </select>
          <button type="submit" className="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 rounded-md">
            Comenzar
          </button>
        </form>
      </div>
    </div>
  );
};

export default UserSetupModal;
